import { randomUUID } from "node:crypto";
import type { ModelClient } from "../model/client";
import { Scheduler, type SchedulerEvent } from "../scheduler";
import type { AgentState, Message } from "../state";
import {
	PersistentTaskStore,
	type Task,
	type TaskActor,
	type TaskDraft,
	type TaskStatus,
	type TaskUpdateOutcome,
	type TaskUpdateRequest,
} from "../tasks";
import type { Tools } from "../tools/types";
import { AgentMailbox, type AgentMessage } from "./mailbox";
import { runSubagent } from "./runAgent";
import type {
	AgentMemoryUpdate,
	AgentRecord,
	AgentResult,
	AgentRuntime,
	AgentRuntimeEvent,
	AgentRuntimeListener,
	SpawnAgentRequest,
	SpawnAgentResponse,
} from "./types";
import { AGENT_COORDINATION_PREFIX } from "./types";

const DEFAULT_MAX_CONCURRENT_AGENTS = 4;
const DEFAULT_MAX_SCHEDULED_AGENTS = 3;
const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_TURNS = 12;
const MAX_WAIT_TIMEOUT_MS = 10 * 60_000;
const HEARTBEAT_INTERVAL_MS = 5_000;

type RunningAgent = {
	controller: AbortController;
	completion: Promise<AgentResult>;
};

type ScheduledBinding = {
	taskId: string;
	runId: string;
};

export class InProcessAgentManager implements AgentRuntime {
	private readonly records = new Map<string, AgentRecord>();
	private readonly running = new Map<string, RunningAgent>();
	private readonly mailbox = new AgentMailbox<AgentMessage<AgentResult>>();
	private readonly listeners = new Set<AgentRuntimeListener>();
	private readonly notified = new Set<string>();
	private readonly memoryQueued = new Set<string>();
	private readonly pendingMemory = new Map<string, AgentMemoryUpdate>();
	private readonly quiescingSessions = new Set<string>();
	private readonly taskStores = new Map<string, PersistentTaskStore>();
	private readonly schedulers = new Map<string, Scheduler>();
	private readonly slots: AgentSlotPool;
	private closed = false;
	private shutdownPromise?: Promise<void>;

	readonly tasks = {
		create: async (
			requesterState: AgentState,
			drafts: readonly TaskDraft[],
		) => {
			if (requesterState.agent.depth !== 0) {
				throw new Error("only the main agent can create shared tasks");
			}
			const { store } = this.coordinationFor(requesterState);
			return store.createBatch(drafts);
		},
		get: async (requesterState: AgentState, taskId: string) => {
			const { store } = this.coordinationFor(requesterState);
			const task = await store.get(taskId);
			this.assertTaskVisibleTo(requesterState, task);
			return task;
		},
		list: async (
			requesterState: AgentState,
			filter: {
				readyOnly?: boolean;
				status?: readonly TaskStatus[];
				unownedOnly?: boolean;
			} = {},
		) => {
			if (requesterState.agent.depth !== 0) {
				throw new Error("only the main agent can list the shared task graph");
			}
			const { store } = this.coordinationFor(requesterState);
			return store.list(filter);
		},
		update: async (
			requesterState: AgentState,
			request: TaskUpdateRequest,
		): Promise<TaskUpdateOutcome> => {
			const { store, scheduler } = this.coordinationFor(requesterState);
			const actor = this.taskActor(requesterState);
			if (request.action === "cancel") {
				if (!actor.isRoot) {
					throw new Error("only the main agent can cancel tasks");
				}
				return scheduler.cancelTask(
					request.taskId,
					request.expectedVersion,
					request.idempotencyKey,
					request.reason ?? "cancelled by main agent",
					request.cascade ?? true,
				);
			}
			return store.update(request, actor);
		},
	};

	constructor(
		private readonly options: {
			model: ModelClient;
			getTools(): Tools;
			maxConcurrentAgents?: number;
			maxScheduledAgents?: number;
			maxDepth?: number;
			defaultMaxTurns?: number;
		},
	) {
		this.slots = new AgentSlotPool(
			positiveInteger(
				options.maxConcurrentAgents,
				DEFAULT_MAX_CONCURRENT_AGENTS,
			),
		);
	}

	attach(state: AgentState): void {
		if (state.agent.depth === 0) {
			this.coordinationFor(state);
		}
	}

	async spawn(
		parentState: AgentState,
		request: SpawnAgentRequest,
	): Promise<SpawnAgentResponse> {
		this.assertOpen();
		const parent = parentState.agent;
		const maxDepth = positiveInteger(this.options.maxDepth, DEFAULT_MAX_DEPTH);
		if (parent.depth >= maxDepth) {
			throw new Error(`sub-agent depth limit reached (${maxDepth})`);
		}
		if (!request.task.trim()) {
			throw new Error("sub-agent task cannot be empty");
		}
		if (request.name) {
			const duplicate = this.list(parentState).find(
				(record) => record.name === request.name && !isTerminal(record.status),
			);
			if (duplicate) {
				throw new Error(`agent name is already active: ${request.name}`);
			}
		}

		const rootSessionId = this.rootSessionId(parentState);
		if (this.quiescingSessions.has(rootSessionId)) {
			throw new Error(
				"sub-agent spawning is paused during a permission policy change",
			);
		}
		const { record, completion } = this.launchAgent(parentState, request);

		if (record.background) {
			return {
				status: "background",
				agentId: record.id,
				description: record.description,
			};
		}

		return {
			status: "completed",
			agentId: record.id,
			result: await completion,
		};
	}

	list(requesterState: AgentState): AgentRecord[] {
		const sessionId = this.rootSessionId(requesterState);
		return [...this.records.values()]
			.filter((record) => record.sessionId === sessionId)
			.map(cloneRecord)
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	async wait(
		requesterState: AgentState,
		agentId: string,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<AgentResult> {
		if (requesterState.agent.id === agentId) {
			throw new Error("an agent cannot wait for itself");
		}
		const record = this.recordFor(requesterState, agentId);
		if (record.result) {
			return { ...record.result };
		}
		const running = this.running.get(agentId);
		if (!running) {
			throw new Error(`agent has no completion result: ${agentId}`);
		}

		if (timeoutMs === undefined && !signal) {
			return { ...(await running.completion) };
		}
		if (signal?.aborted) {
			throw abortError(signal);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		const racers: Promise<AgentResult>[] = [running.completion];
		if (timeoutMs !== undefined) {
			const safeTimeout = Math.max(1, Math.min(timeoutMs, MAX_WAIT_TIMEOUT_MS));
			racers.push(
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error(`timed out waiting for agent: ${agentId}`)),
						safeTimeout,
					);
				}),
			);
		}
		if (signal) {
			racers.push(
				new Promise<never>((_resolve, reject) => {
					onAbort = () => reject(abortError(signal));
					signal.addEventListener("abort", onAbort, { once: true });
				}),
			);
		}
		try {
			return { ...(await Promise.race(racers)) };
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			if (signal && onAbort) {
				signal.removeEventListener("abort", onAbort);
			}
		}
	}

	send(
		requesterState: AgentState,
		agentId: string,
		content: string,
	): { messageId: string } {
		if (requesterState.agent.id === agentId) {
			throw new Error("an agent cannot message itself");
		}
		const rootAgentId = this.rootAgentId(requesterState);
		if (agentId !== rootAgentId) {
			const record = this.recordFor(requesterState, agentId);
			if (record.status !== "created" && record.status !== "running") {
				throw new Error(`cannot message terminal agent: ${agentId}`);
			}
		}
		if (!content.trim()) {
			throw new Error("agent message cannot be empty");
		}
		const messageId = randomUUID();
		this.mailbox.send({
			type: "message",
			id: messageId,
			from: requesterState.agent.id,
			to: agentId,
			content: content.trim(),
		});
		this.emit({ type: "inbox", agentId, recipientId: agentId });
		return { messageId };
	}

	async cancel(
		requesterState: AgentState,
		agentId: string,
		reason = "cancelled by parent agent",
	): Promise<boolean> {
		const record = this.recordFor(requesterState, agentId);
		const requesterId = requesterState.agent.id;
		if (
			requesterId !== record.parentId &&
			requesterId !== this.rootAgentId(requesterState)
		) {
			throw new Error(`agent is not allowed to cancel: ${agentId}`);
		}
		if (isTerminal(record.status) || record.status === "cancelling") {
			return false;
		}
		if (record.taskId && record.runId) {
			const store = this.taskStores.get(record.sessionId);
			await store?.releaseSpawnFailure({
				taskId: record.taskId,
				agentId: record.id,
				runId: record.runId,
				error: reason,
			});
		}
		this.requestCancellation(record, reason);
		this.schedulers.get(record.sessionId)?.requestSchedule();
		return true;
	}

	async quiesceForPermissionChange(
		requesterState: AgentState,
		reason = "cancelled because the permission policy changed",
	): Promise<number> {
		this.assertOpen();
		if (requesterState.agent.depth !== 0) {
			throw new Error(
				"only the root agent can quiesce a session for a permission policy change",
			);
		}

		const sessionId = this.rootSessionId(requesterState);
		if (this.quiescingSessions.has(sessionId)) {
			throw new Error("permission policy change is already in progress");
		}
		this.quiescingSessions.add(sessionId);
		try {
			const activeRecords = [...this.records.values()].filter(
				(record) =>
					record.sessionId === sessionId && !isTerminal(record.status),
			);
			const completions = activeRecords.flatMap((record) => {
				const running = this.running.get(record.id);
				return running ? [running.completion] : [];
			});

			for (const record of activeRecords) {
				if (record.status !== "cancelling") {
					this.requestCancellation(record, reason);
				}
			}
			await Promise.all(completions);
			return activeRecords.length;
		} finally {
			this.quiescingSessions.delete(sessionId);
		}
	}

	drainMessages(agentId: string): Message[] {
		return this.mailbox.drain(agentId).map(toModelMessage);
	}

	drainMemory(agentId: string): AgentMemoryUpdate {
		const update = this.pendingMemory.get(agentId);
		this.pendingMemory.delete(agentId);
		return update
			? {
					toolExecutions: update.toolExecutions.map((execution) => ({
						...execution,
					})),
					changedFiles: update.changedFiles.slice(),
				}
			: { toolExecutions: [], changedFiles: [] };
	}

	beginCompletion(agentId: string): void {
		const record = this.records.get(agentId);
		if (record?.status === "running") {
			this.updateRecord(agentId, { status: "completing" });
		}
	}

	hasPendingMessages(agentId: string): boolean {
		return this.mailbox.hasMessages(agentId);
	}

	subscribe(listener: AgentRuntimeListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) {
			return this.shutdownPromise;
		}
		this.closed = true;
		this.shutdownPromise = Promise.resolve().then(() => this.performShutdown());
		return this.shutdownPromise;
	}

	private async performShutdown(): Promise<void> {
		await Promise.allSettled(
			[...this.schedulers.values()].map((scheduler) =>
				scheduler.shutdown("agent runtime shutdown"),
			),
		);
		for (const record of this.records.values()) {
			if (!isTerminal(record.status) && record.status !== "cancelling") {
				this.requestCancellation(record, "agent runtime shutdown");
			}
		}
		await Promise.allSettled(
			[...this.running.values()].map((running) => running.completion),
		);
		this.mailbox.close();
		this.schedulers.clear();
		this.taskStores.clear();
		this.listeners.clear();
	}

	private launchAgent(
		parentState: AgentState,
		request: SpawnAgentRequest,
		options: {
			id?: string;
			binding?: ScheduledBinding;
		} = {},
	): { record: AgentRecord; completion: Promise<AgentResult> } {
		this.assertOpen();
		const id = options.id ?? randomUUID();
		if (this.records.has(id)) {
			throw new Error(`agent ID is already registered: ${id}`);
		}
		const rootSessionId = this.rootSessionId(parentState);
		if (this.quiescingSessions.has(rootSessionId)) {
			throw new Error(
				"sub-agent spawning is paused during a permission policy change",
			);
		}
		const now = new Date().toISOString();
		const record: AgentRecord = {
			id,
			parentId: parentState.agent.id,
			sessionId: rootSessionId,
			childSessionId: `${rootSessionId}.agent.${id}`,
			name: request.name,
			description:
				request.description?.trim() || request.task.trim().slice(0, 80),
			task: request.task.trim(),
			agentType: request.agentType ?? "general-purpose",
			depth: parentState.agent.depth + 1,
			background: request.runInBackground === true,
			status: "created",
			taskId: options.binding?.taskId,
			runId: options.binding?.runId,
			createdAt: now,
			lastHeartbeatAt: now,
		};
		this.records.set(id, record);
		this.emitStatus(record);

		const controller = new AbortController();
		const completion = this.runRecord(record, parentState, request, controller);
		this.running.set(id, { controller, completion });
		void completion.finally(() => {
			this.running.delete(id);
		});
		return { record, completion };
	}

	private coordinationFor(state: AgentState): {
		store: PersistentTaskStore;
		scheduler: Scheduler;
	} {
		const sessionId = this.rootSessionId(state);
		let store = this.taskStores.get(sessionId);
		if (!store) {
			store = new PersistentTaskStore(state.cwd, sessionId);
			this.taskStores.set(sessionId, store);
		}
		let scheduler = this.schedulers.get(sessionId);
		if (!scheduler) {
			scheduler = new Scheduler({
				store,
				maxConcurrency: positiveInteger(
					this.options.maxScheduledAgents,
					DEFAULT_MAX_SCHEDULED_AGENTS,
				),
				runningCount: () =>
					[...this.records.values()].filter(
						(record) =>
							record.sessionId === sessionId && !isTerminal(record.status),
					).length,
				startAgent: (input) => {
					this.startScheduledAgent(input, scheduler as Scheduler);
				},
				cancelAgent: (agentId, reason) => {
					const record = this.records.get(agentId);
					if (
						record &&
						record.sessionId === sessionId &&
						!isTerminal(record.status) &&
						record.status !== "cancelling"
					) {
						this.requestCancellation(record, reason);
					}
				},
			});
			const rootAgentId = this.rootAgentId(state);
			scheduler.subscribe((event) =>
				this.notifySchedulerEvent(rootAgentId, event),
			);
			this.schedulers.set(sessionId, scheduler);
		}
		if (state.agent.depth === 0) {
			scheduler.attachParentState(state);
		}
		return { store, scheduler };
	}

	private startScheduledAgent(
		input: {
			parentState: AgentState;
			task: Task;
			agentId: string;
			runId: string;
		},
		scheduler: Scheduler,
	): void {
		const request: SpawnAgentRequest = {
			task: buildScheduledTaskPrompt(input.task),
			description: input.task.subject,
			name: input.task.id,
			agentType: "general-purpose",
			runInBackground: true,
			contextMode: "task-only",
		};
		const { completion } = this.launchAgent(input.parentState, request, {
			id: input.agentId,
			binding: { taskId: input.task.id, runId: input.runId },
		});
		void completion
			.then(async (result) => {
				const applied = await scheduler.handleAgentResult({
					agentId: input.agentId,
					runId: input.runId,
					taskId: input.task.id,
					result,
				});
				if (applied) {
					this.queueParentMemory(input.agentId, result);
					this.notifyParent(input.agentId, result);
				}
			})
			.catch((caught) => {
				this.notifySchedulerEvent(this.rootAgentId(input.parentState), {
					type: "scheduler_error",
					error: formatCaught(caught),
				});
			});
	}

	private notifySchedulerEvent(
		rootAgentId: string,
		event: SchedulerEvent,
	): void {
		const message =
			event.type === "scheduler_stalled"
				? `<scheduler-stalled>\nNo runnable tasks remain.\nBlocked tasks: ${event.blockedTaskIds.join(", ")}\nGraph validation: ${JSON.stringify(event.validation)}\n</scheduler-stalled>`
				: `<scheduler-error>${event.error}</scheduler-error>`;
		this.mailbox.send({
			type: "message",
			id: randomUUID(),
			from: "scheduler",
			to: rootAgentId,
			content: message,
		});
		this.emit({
			type: event.type,
			agentId: "scheduler",
			recipientId: rootAgentId,
			message,
		});
		this.emit({
			type: "inbox",
			agentId: "scheduler",
			recipientId: rootAgentId,
		});
	}

	private taskActor(state: AgentState): TaskActor {
		if (state.agent.depth === 0) {
			return { agentId: state.agent.id, isRoot: true };
		}
		const record = this.records.get(state.agent.id);
		return {
			agentId: state.agent.id,
			taskId: record?.taskId,
			runId: record?.runId,
			isRoot: false,
		};
	}

	private assertTaskVisibleTo(state: AgentState, task: Task | undefined): void {
		if (!task || state.agent.depth === 0) {
			return;
		}
		const record = this.records.get(state.agent.id);
		if (record?.taskId !== task.id) {
			throw new Error(`agent ${state.agent.id} cannot inspect task ${task.id}`);
		}
	}

	private async runRecord(
		record: AgentRecord,
		parentState: AgentState,
		request: SpawnAgentRequest,
		controller: AbortController,
	): Promise<AgentResult> {
		let releaseSlot: (() => void) | undefined;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		try {
			releaseSlot = await this.slots.acquire(controller.signal);
			const beforeStart = this.records.get(record.id);
			if (!beforeStart) {
				return cancelledResult(record.id, "agent record disappeared");
			}
			if (beforeStart.status === "cancelling" || controller.signal.aborted) {
				return this.finishRecord(
					record.id,
					cancelledResult(record.id, beforeStart.error ?? "cancelled"),
				);
			}
			const startedAt = new Date().toISOString();
			this.updateRecord(record.id, {
				status: "running",
				startedAt,
				lastHeartbeatAt: startedAt,
			});
			heartbeat = setInterval(() => {
				const current = this.records.get(record.id);
				if (current && !isTerminal(current.status)) {
					this.updateRecord(record.id, {
						lastHeartbeatAt: new Date().toISOString(),
					});
				}
			}, HEARTBEAT_INTERVAL_MS);
			heartbeat.unref?.();

			const result = await runSubagent({
				identity: {
					id: record.id,
					parentId: record.parentId,
					name: record.name,
					type: record.agentType,
					depth: record.depth,
				},
				parentState,
				task: record.task,
				contextMode: request.contextMode ?? "task-only",
				model: this.options.model,
				tools: this.options.getTools(),
				agentRuntime: this,
				maxTurns: positiveInteger(
					request.maxTurns,
					positiveInteger(this.options.defaultMaxTurns, DEFAULT_MAX_TURNS),
				),
				signal: controller.signal,
			});
			return this.finishRecord(record.id, result);
		} catch (caught) {
			const current = this.records.get(record.id);
			if (current?.status === "cancelled" && current.result) {
				return current.result;
			}
			const message = formatCaught(caught);
			const cancellationReason =
				current?.status === "cancelling" && current.error
					? current.error
					: message;
			const result: AgentResult = controller.signal.aborted
				? cancelledResult(record.id, cancellationReason)
				: {
						agentId: record.id,
						status: "failed",
						summary: `Sub-agent failed: ${message}`,
						changedFiles: [],
						toolExecutions: [],
						turnsUsed: 0,
						error: message,
					};
			return this.finishRecord(record.id, result);
		} finally {
			if (heartbeat) {
				clearInterval(heartbeat);
			}
			releaseSlot?.();
		}
	}

	private finishRecord(agentId: string, result: AgentResult): AgentResult {
		const record = this.records.get(agentId);
		if (!record) {
			return result;
		}
		if (record.status === "cancelled" && record.result) {
			return record.result;
		}
		const finalResult =
			record.status === "cancelling"
				? cancelledResult(
						agentId,
						record.error ?? "cancelled before completion committed",
						result,
					)
				: result;
		this.updateRecord(agentId, {
			status: finalResult.status,
			result: finalResult,
			error: finalResult.error,
			completedAt: new Date().toISOString(),
			lastHeartbeatAt: new Date().toISOString(),
		});
		this.mailbox.drain(agentId);
		if (!record.taskId) {
			this.queueParentMemory(agentId, finalResult);
			this.notifyParent(agentId, finalResult);
		}
		return finalResult;
	}

	private requestCancellation(record: AgentRecord, reason: string): void {
		this.updateRecord(record.id, {
			status: "cancelling",
			error: reason,
		});
		this.running.get(record.id)?.controller.abort(reason);
	}

	private notifyParent(agentId: string, result: AgentResult): void {
		const record = this.records.get(agentId);
		if (!record?.background || this.notified.has(agentId)) {
			return;
		}
		this.notified.add(agentId);
		if (result.status === "failed") {
			this.mailbox.send({
				type: "failed",
				id: randomUUID(),
				from: agentId,
				to: record.parentId,
				error: result.error ?? result.summary,
			});
		} else {
			this.mailbox.send({
				type: "completed",
				id: randomUUID(),
				from: agentId,
				to: record.parentId,
				result,
			});
		}
		this.emit({
			type: "inbox",
			agentId,
			recipientId: record.parentId,
		});
	}

	private queueParentMemory(agentId: string, result: AgentResult): void {
		const record = this.records.get(agentId);
		if (!record || this.memoryQueued.has(agentId)) {
			return;
		}
		this.memoryQueued.add(agentId);
		if (
			result.toolExecutions.length === 0 &&
			result.changedFiles.length === 0
		) {
			return;
		}
		const previous = this.pendingMemory.get(record.parentId) ?? {
			toolExecutions: [],
			changedFiles: [],
		};
		const executions = new Map(
			previous.toolExecutions.map((execution) => [execution.callId, execution]),
		);
		for (const execution of result.toolExecutions) {
			executions.set(execution.callId, { ...execution });
		}
		this.pendingMemory.set(record.parentId, {
			toolExecutions: [...executions.values()],
			changedFiles: [
				...new Set([...previous.changedFiles, ...result.changedFiles]),
			],
		});
	}

	private recordFor(requesterState: AgentState, agentId: string): AgentRecord {
		const record = this.records.get(agentId);
		if (!record || record.sessionId !== this.rootSessionId(requesterState)) {
			throw new Error(`unknown agent: ${agentId}`);
		}
		return record;
	}

	private rootSessionId(state: AgentState): string {
		if (state.agent.depth === 0) {
			return state.sessionId;
		}
		return this.records.get(state.agent.id)?.sessionId ?? state.sessionId;
	}

	private rootAgentId(state: AgentState): string {
		let agentId = state.agent.id;
		let record = this.records.get(agentId);
		while (record) {
			agentId = record.parentId;
			record = this.records.get(agentId);
		}
		return agentId;
	}

	private updateRecord(
		agentId: string,
		patch: Partial<AgentRecord>,
	): AgentRecord | undefined {
		const previous = this.records.get(agentId);
		if (!previous) {
			return undefined;
		}
		const next = { ...previous, ...patch };
		this.records.set(agentId, next);
		this.emitStatus(next);
		return next;
	}

	private emitStatus(record: AgentRecord): void {
		this.emit({
			type: "agent_status",
			agentId: record.id,
			record: cloneRecord(record),
		});
	}

	private emit(event: AgentRuntimeEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// A UI/event observer must not break agent lifecycle transitions.
			}
		}
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new Error("agent runtime is closed");
		}
	}
}

class AgentSlotPool {
	private active = 0;
	private readonly waiters: Array<{
		resolve(release: () => void): void;
		reject(error: Error): void;
		signal: AbortSignal;
		onAbort(): void;
	}> = [];

	constructor(private readonly limit: number) {}

	acquire(signal: AbortSignal): Promise<() => void> {
		if (signal.aborted) {
			return Promise.reject(abortError(signal));
		}
		if (this.active < this.limit) {
			this.active++;
			return Promise.resolve(this.createRelease());
		}

		return new Promise((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				signal,
				onAbort: () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) {
						this.waiters.splice(index, 1);
					}
					reject(abortError(signal));
				},
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
			this.waiters.push(waiter);
		});
	}

	private createRelease(): () => void {
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this.active--;
			this.startNext();
		};
	}

	private startNext(): void {
		while (this.active < this.limit) {
			const waiter = this.waiters.shift();
			if (!waiter) {
				return;
			}
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal.aborted) {
				waiter.reject(abortError(waiter.signal));
				continue;
			}
			this.active++;
			waiter.resolve(this.createRelease());
		}
	}
}

function toModelMessage(message: AgentMessage<AgentResult>): Message {
	if (message.type === "message") {
		return coordinationMessage({
			kind: "agent-message",
			from: message.from,
			content: message.content,
		});
	}
	if (message.type === "completed") {
		return coordinationMessage({
			kind: "agent-notification",
			agentId: message.from,
			status: message.result.status,
			summary: message.result.summary,
			changedFiles: message.result.changedFiles,
			toolExecutions: message.result.toolExecutions,
		});
	}
	if (message.type === "failed") {
		return coordinationMessage({
			kind: "agent-notification",
			agentId: message.from,
			status: "failed",
			error: message.error,
		});
	}
	return coordinationMessage({
		kind: "agent-notification",
		from: message.from,
		status: "cancelled",
		reason: message.reason ?? "cancelled",
	});
}

function coordinationMessage(payload: Record<string, unknown>): Message {
	return {
		role: "agent",
		content: `${AGENT_COORDINATION_PREFIX}${JSON.stringify(payload)}`,
	};
}

function buildScheduledTaskPrompt(task: Task): string {
	return [
		`You are assigned persistent task ${task.id}.`,
		`Subject: ${task.subject}`,
		task.description ? `Description:\n${task.description}` : "",
		`Run ID: ${task.activeRunId ?? "unbound"}`,
		"",
		"Work only on this task. Use TaskGet to inspect current task metadata and TaskUpdate(action=progress) for material progress updates.",
		"Do not mark the task completed or failed yourself. Return a concise final result with summary, changed files, verification evidence, and remaining risks; the host runtime is the final task-state authority.",
	]
		.filter(Boolean)
		.join("\n");
}

function cloneRecord(record: AgentRecord): AgentRecord {
	return {
		...record,
		result: record.result
			? {
					...record.result,
					changedFiles: record.result.changedFiles.slice(),
					toolExecutions: record.result.toolExecutions.map((item) => ({
						...item,
					})),
				}
			: undefined,
	};
}

function cancelledResult(
	agentId: string,
	reason: string,
	partial?: AgentResult,
): AgentResult {
	return {
		agentId,
		status: "cancelled",
		summary: `Sub-agent cancelled: ${reason}`,
		changedFiles: partial?.changedFiles.slice() ?? [],
		toolExecutions:
			partial?.toolExecutions.map((execution) => ({ ...execution })) ?? [],
		turnsUsed: partial?.turnsUsed ?? 0,
		error: reason,
	};
}

function isTerminal(status: AgentRecord["status"]): boolean {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value > 0
		? value
		: fallback;
}

function abortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	const error = new Error(
		typeof reason === "string" ? reason : "agent operation aborted",
	);
	error.name = "AbortError";
	return error;
}

function formatCaught(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}
