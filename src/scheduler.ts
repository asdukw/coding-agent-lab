import { randomUUID } from "node:crypto";
import type { AgentResult } from "./agents/types";
import type { AgentState } from "./state";
import type {
	PersistentTaskStore,
	Task,
	TaskGraphValidation,
	TaskStoreEvent,
	TaskUpdateOutcome,
} from "./tasks";

export type SchedulerEvent =
	| {
			type: "scheduler_stalled";
			blockedTaskIds: string[];
			validation: TaskGraphValidation;
	  }
	| {
			type: "scheduler_error";
			error: string;
	  };

export type SchedulerListener = (event: SchedulerEvent) => void;

export class Scheduler {
	private scheduling = false;
	private rescheduleRequested = false;
	private stopped = false;
	private fallbackTimer?: ReturnType<typeof setInterval>;
	private parentState?: AgentState;
	private lastStallFingerprint?: string;
	private readonly listeners = new Set<SchedulerListener>();
	private readonly unsubscribeStore: () => void;

	constructor(
		private readonly options: {
			store: PersistentTaskStore;
			maxConcurrency: number;
			runningCount(): number;
			startAgent(input: {
				parentState: AgentState;
				task: Task;
				agentId: string;
				runId: string;
			}): void;
			cancelAgent(agentId: string, reason: string): void;
			fallbackIntervalMs?: number;
		},
	) {
		this.unsubscribeStore = options.store.subscribe((event) => {
			this.onTaskEvent(event);
		});
		const interval = Math.max(250, options.fallbackIntervalMs ?? 2_000);
		this.fallbackTimer = setInterval(() => {
			this.requestSchedule();
		}, interval);
		this.fallbackTimer.unref?.();
	}

	subscribe(listener: SchedulerListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	attachParentState(state: AgentState): void {
		this.parentState = state;
		this.requestSchedule();
	}

	requestSchedule(): void {
		if (this.stopped || !this.parentState) {
			return;
		}
		if (this.scheduling) {
			this.rescheduleRequested = true;
			return;
		}
		void this.schedule().catch((caught) => {
			this.emit({ type: "scheduler_error", error: formatCaught(caught) });
		});
	}

	async handleAgentResult(input: {
		agentId: string;
		runId: string;
		taskId: string;
		result: AgentResult;
	}): Promise<boolean> {
		const settlement =
			input.result.status === "completed"
				? {
						status: "completed" as const,
						summary: input.result.summary,
						artifacts: input.result.changedFiles,
					}
				: input.result.status === "failed"
					? {
							status: "failed" as const,
							error: input.result.error ?? input.result.summary,
						}
					: {
							status: "cancelled" as const,
							reason: input.result.error ?? input.result.summary,
						};
		const settled = await this.options.store.settleAgentRun({
			taskId: input.taskId,
			agentId: input.agentId,
			runId: input.runId,
			result: settlement,
		});
		this.requestSchedule();
		return settled.applied;
	}

	async cancelTask(
		taskId: string,
		expectedVersion: number,
		idempotencyKey: string,
		reason: string,
		cascade = true,
	): Promise<TaskUpdateOutcome> {
		if (!this.parentState) {
			throw new Error("scheduler has no attached main agent state");
		}
		const outcome = await this.options.store.update(
			{
				taskId,
				action: "cancel",
				expectedVersion,
				idempotencyKey,
				reason,
				cascade,
			},
			{
				agentId: this.parentState.agent.id,
				isRoot: true,
			},
		);
		for (const binding of outcome.cancelledBindings) {
			this.options.cancelAgent(binding.agentId, reason);
		}
		this.requestSchedule();
		return outcome;
	}

	async shutdown(reason = "main session shutdown"): Promise<void> {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		this.unsubscribeStore();
		if (this.fallbackTimer) {
			clearInterval(this.fallbackTimer);
			this.fallbackTimer = undefined;
		}
		const bindings = await this.options.store.cancelAll(reason);
		for (const binding of bindings) {
			this.options.cancelAgent(binding.agentId, reason);
		}
		this.listeners.clear();
	}

	private async schedule(): Promise<void> {
		if (this.scheduling || this.stopped || !this.parentState) {
			return;
		}
		this.scheduling = true;
		try {
			do {
				this.rescheduleRequested = false;
				while (!this.stopped) {
					const capacity =
						this.options.maxConcurrency - this.options.runningCount();
					if (capacity <= 0) {
						return;
					}
					const ready = await this.options.store.list({
						readyOnly: true,
						status: ["pending"],
						unownedOnly: true,
					});
					if (ready.length === 0) {
						await this.detectStall();
						return;
					}
					let started = 0;
					for (const candidate of ready.slice(0, capacity)) {
						const agentId = randomUUID();
						const runId = randomUUID();
						const reserved = await this.options.store.reserve({
							taskId: candidate.id,
							agentId,
							runId,
						});
						if (!reserved) {
							continue;
						}
						try {
							this.options.startAgent({
								parentState: this.parentState,
								task: reserved,
								agentId,
								runId,
							});
							started++;
						} catch (caught) {
							await this.options.store.releaseSpawnFailure({
								taskId: reserved.id,
								agentId,
								runId,
								error: `Agent spawn failed: ${formatCaught(caught)}`,
							});
						}
					}
					if (started === 0) {
						return;
					}
				}
			} while (this.rescheduleRequested);
		} finally {
			this.scheduling = false;
			if (this.rescheduleRequested && !this.stopped) {
				this.requestSchedule();
			}
		}
	}

	private async detectStall(): Promise<void> {
		const tasks = await this.options.store.list();
		const unfinished = tasks.filter(
			(task) => task.status !== "completed" && task.status !== "cancelled",
		);
		const running = unfinished.some((task) => task.status === "running");
		if (unfinished.length === 0 || running) {
			this.lastStallFingerprint = undefined;
			return;
		}
		const validation = await this.options.store.validate();
		const blockedTaskIds = unfinished.map((task) => task.id);
		const fingerprint = JSON.stringify({ blockedTaskIds, validation });
		if (fingerprint === this.lastStallFingerprint) {
			return;
		}
		this.lastStallFingerprint = fingerprint;
		this.emit({ type: "scheduler_stalled", blockedTaskIds, validation });
	}

	private onTaskEvent(event: TaskStoreEvent): void {
		if (
			event.type === "tasks_created" ||
			event.type === "dependencies_updated" ||
			event.type === "task_completed" ||
			event.type === "task_failed" ||
			event.type === "task_released" ||
			event.type === "tasks_cancelled"
		) {
			this.lastStallFingerprint = undefined;
			this.requestSchedule();
		}
	}

	private emit(event: SchedulerEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

function formatCaught(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}
