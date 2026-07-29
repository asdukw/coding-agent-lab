import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const TASK_STATUSES = [
	"pending",
	"running",
	"completed",
	"failed",
	"cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskResult = {
	summary: string;
	artifacts?: string[];
};

export type Task = {
	id: string;
	subject: string;
	description: string;
	status: TaskStatus;
	blockedBy: string[];
	blocks: string[];
	ownerAgentId?: string;
	activeRunId?: string;
	attempt: number;
	maxAttempts: number;
	result?: TaskResult;
	error?: string;
	progress?: string;
	version: number;
	createdAt: number;
	updatedAt: number;
	idempotencyKeys: string[];
};

export type TaskDraft = {
	clientId: string;
	subject: string;
	description?: string;
	blockedBy: string[];
	maxAttempts?: number;
};

export type TaskGraph = {
	tasks: Record<string, Task>;
	nextSequence: number;
};

export type TaskStoreEvent = {
	type:
		| "tasks_created"
		| "dependencies_updated"
		| "task_reserved"
		| "task_progress"
		| "task_completed"
		| "task_failed"
		| "task_released"
		| "tasks_cancelled";
	taskIds: string[];
	timestamp: number;
};

export type TaskStoreListener = (event: TaskStoreEvent) => void;

export type TaskUpdateRequest = {
	taskId: string;
	action: "progress" | "retry" | "cancel" | "add_dependencies";
	expectedVersion: number;
	idempotencyKey: string;
	progress?: string;
	blockedBy?: string[];
	reason?: string;
	cascade?: boolean;
};

export type TaskActor = {
	agentId: string;
	taskId?: string;
	runId?: string;
	isRoot: boolean;
};

export type TaskUpdateOutcome = {
	task: Task;
	idempotentReplay: boolean;
	cancelledBindings: Array<{ agentId: string; runId: string; taskId: string }>;
};

export type AgentSettlement =
	| { status: "completed"; summary: string; artifacts?: string[] }
	| { status: "failed"; error: string }
	| { status: "cancelled"; reason?: string };

export type TaskGraphValidation =
	| { valid: true }
	| {
			valid: false;
			reason:
				| "missing_dependency"
				| "self_dependency"
				| "dependency_cycle"
				| "inconsistent_edge";
			taskId: string;
			dependencyId?: string;
			cycle?: string[];
	  };

const taskResultSchema = z
	.object({
		summary: z.string().max(20_000),
		artifacts: z.array(z.string().max(2_000)).max(1_000).optional(),
	})
	.strict();

const taskSchema: z.ZodType<Task> = z
	.object({
		id: z.string().regex(/^task-[1-9]\d*$/),
		subject: z.string().min(1).max(200),
		description: z.string().max(20_000),
		status: z.enum(TASK_STATUSES),
		blockedBy: z.array(z.string().regex(/^task-[1-9]\d*$/)).max(1_000),
		blocks: z.array(z.string().regex(/^task-[1-9]\d*$/)).max(1_000),
		ownerAgentId: z.string().min(1).max(200).optional(),
		activeRunId: z.string().uuid().optional(),
		attempt: z.number().int().nonnegative(),
		maxAttempts: z.number().int().min(1).max(10),
		result: taskResultSchema.optional(),
		error: z.string().max(20_000).optional(),
		progress: z.string().max(20_000).optional(),
		version: z.number().int().positive(),
		createdAt: z.number().int().nonnegative(),
		updatedAt: z.number().int().nonnegative(),
		idempotencyKeys: z.array(z.string().min(1).max(200)).max(10_000),
	})
	.strict();

const taskGraphSchema = z
	.object({
		tasks: z.record(z.string(), taskSchema),
		nextSequence: z.number().int().positive(),
	})
	.strict();

export class PersistentTaskStore {
	private graph?: TaskGraph;
	private writeTail: Promise<void> = Promise.resolve();
	private readonly listeners = new Set<TaskStoreListener>();
	readonly path: string;

	constructor(
		cwd: string,
		readonly sessionId: string,
	) {
		if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
			throw new Error(`invalid task store session ID: ${sessionId}`);
		}
		this.path = resolve(cwd, ".cagent", "tasks", `${sessionId}.json`);
	}

	subscribe(listener: TaskStoreListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async createBatch(drafts: readonly TaskDraft[]): Promise<Task[]> {
		return this.mutate((graph) => {
			const result = createTaskGraphBatch(graph, drafts);
			return {
				graph: result.graph,
				value: result.tasks,
				event: taskEvent(
					"tasks_created",
					result.tasks.map((task) => task.id),
				),
			};
		});
	}

	async get(taskId: string): Promise<Task | undefined> {
		const graph = await this.readGraph();
		const task = graph.tasks[taskId];
		return task ? cloneTask(task) : undefined;
	}

	async list(
		filter: {
			readyOnly?: boolean;
			status?: readonly TaskStatus[];
			unownedOnly?: boolean;
		} = {},
	): Promise<Task[]> {
		const graph = await this.readGraph();
		return Object.values(graph.tasks)
			.filter((task) => !filter.status || filter.status.includes(task.status))
			.filter((task) => !filter.unownedOnly || !task.ownerAgentId)
			.filter((task) => !filter.readyOnly || isTaskReady(task, graph.tasks))
			.sort((left, right) => compareTaskIds(left.id, right.id))
			.map(cloneTask);
	}

	async reserve(input: {
		taskId: string;
		agentId: string;
		runId: string;
	}): Promise<Task | undefined> {
		return this.mutate((graph) => {
			const task = graph.tasks[input.taskId];
			if (
				task?.status !== "pending" ||
				task.ownerAgentId ||
				!isTaskReady(task, graph.tasks)
			) {
				return { graph, value: undefined };
			}
			const now = Date.now();
			const updated: Task = {
				...task,
				status: "running",
				ownerAgentId: input.agentId,
				activeRunId: input.runId,
				attempt: task.attempt + 1,
				error: undefined,
				version: task.version + 1,
				updatedAt: now,
			};
			return {
				graph: replaceTask(graph, updated),
				value: cloneTask(updated),
				event: taskEvent("task_reserved", [updated.id], now),
			};
		});
	}

	async releaseSpawnFailure(input: {
		taskId: string;
		agentId: string;
		runId: string;
		error: string;
	}): Promise<boolean> {
		return this.mutate((graph) => {
			const task = graph.tasks[input.taskId];
			if (!isActiveRun(task, input.agentId, input.runId)) {
				return { graph, value: false };
			}
			const now = Date.now();
			const updated: Task = {
				...task,
				status: task.attempt < task.maxAttempts ? "pending" : "failed",
				ownerAgentId: undefined,
				activeRunId: undefined,
				error: input.error,
				version: task.version + 1,
				updatedAt: now,
			};
			return {
				graph: replaceTask(graph, updated),
				value: true,
				event: taskEvent(
					updated.status === "pending" ? "task_released" : "task_failed",
					[updated.id],
					now,
				),
			};
		});
	}

	async settleAgentRun(input: {
		taskId: string;
		agentId: string;
		runId: string;
		result: AgentSettlement;
	}): Promise<{ applied: boolean; task?: Task }> {
		return this.mutate<{ applied: boolean; task?: Task }>((graph) => {
			const task = graph.tasks[input.taskId];
			if (!isActiveRun(task, input.agentId, input.runId)) {
				return { graph, value: { applied: false } };
			}
			const now = Date.now();
			let status: TaskStatus;
			let result: TaskResult | undefined;
			let error: string | undefined;
			let eventType: TaskStoreEvent["type"];
			if (input.result.status === "completed") {
				status = "completed";
				result = {
					summary: input.result.summary,
					artifacts: input.result.artifacts,
				};
				eventType = "task_completed";
			} else if (input.result.status === "failed") {
				status = task.attempt < task.maxAttempts ? "pending" : "failed";
				error = input.result.error;
				eventType = status === "pending" ? "task_released" : "task_failed";
			} else {
				status = "cancelled";
				error = input.result.reason;
				eventType = "tasks_cancelled";
			}
			const updated: Task = {
				...task,
				status,
				ownerAgentId: undefined,
				activeRunId: undefined,
				result,
				error,
				version: task.version + 1,
				updatedAt: now,
			};
			return {
				graph: replaceTask(graph, updated),
				value: { applied: true, task: cloneTask(updated) },
				event: taskEvent(eventType, [updated.id], now),
			};
		});
	}

	async update(
		request: TaskUpdateRequest,
		actor: TaskActor,
	): Promise<TaskUpdateOutcome> {
		return this.mutate<TaskUpdateOutcome>((graph) => {
			const task = requireTask(graph, request.taskId);
			assertTaskActor(task, actor, request.action);
			if (task.idempotencyKeys.includes(request.idempotencyKey)) {
				return {
					graph,
					value: {
						task: cloneTask(task),
						idempotentReplay: true,
						cancelledBindings: [],
					},
				};
			}
			if (task.version !== request.expectedVersion) {
				throw new Error(
					`task ${task.id} version conflict: expected ${request.expectedVersion}, current ${task.version}`,
				);
			}

			if (request.action === "cancel") {
				if (!actor.isRoot) {
					throw new Error("only the main agent can cancel tasks");
				}
				if (task.status === "completed" || task.status === "cancelled") {
					throw new Error(
						`Invalid task transition: ${task.status} -> cancelled`,
					);
				}
				const cancelled = cancelTasks(
					graph,
					task.id,
					request.cascade ?? true,
					request.reason ?? "cancelled by main agent",
					request.idempotencyKey,
				);
				return {
					graph: cancelled.graph,
					value: {
						task: cloneTask(cancelled.graph.tasks[task.id] as Task),
						idempotentReplay: false,
						cancelledBindings: cancelled.bindings,
					},
					event: taskEvent("tasks_cancelled", cancelled.taskIds),
				};
			}

			const now = Date.now();
			let updated: Task;
			let eventType: TaskStoreEvent["type"];
			if (request.action === "progress") {
				if (task.status !== "running") {
					throw new Error(`cannot report progress for ${task.status} task`);
				}
				if (!request.progress?.trim()) {
					throw new Error(
						"progress action requires a non-empty progress value",
					);
				}
				updated = { ...task, progress: request.progress.trim() };
				eventType = "task_progress";
			} else if (request.action === "retry") {
				if (!actor.isRoot || task.status !== "failed") {
					throw new Error(`cannot retry task ${task.id} from ${task.status}`);
				}
				updated = {
					...task,
					status: "pending",
					error: undefined,
					result: undefined,
					progress: undefined,
				};
				eventType = "task_released";
			} else {
				if (!actor.isRoot || task.status !== "pending" || task.ownerAgentId) {
					throw new Error(
						"dependencies can only be changed by main on an unowned pending task",
					);
				}
				if (!request.blockedBy?.length) {
					throw new Error("add_dependencies requires blocked_by");
				}
				const dependencies = unique([...task.blockedBy, ...request.blockedBy]);
				updated = { ...task, blockedBy: dependencies };
				let candidate = replaceTask(graph, updated);
				candidate = rebuildBlocks(candidate);
				assertValidTaskGraph(candidate);
				graph = candidate;
				eventType = "dependencies_updated";
			}

			updated = {
				...(graph.tasks[task.id] ?? updated),
				version: task.version + 1,
				idempotencyKeys: appendIdempotencyKey(
					task.idempotencyKeys,
					request.idempotencyKey,
				),
				updatedAt: now,
			};
			const next = replaceTask(graph, updated);
			return {
				graph: next,
				value: {
					task: cloneTask(updated),
					idempotentReplay: false,
					cancelledBindings: [],
				},
				event: taskEvent(eventType, [updated.id], now),
			};
		});
	}

	async cancelAll(
		reason: string,
	): Promise<Array<{ agentId: string; runId: string; taskId: string }>> {
		return this.mutate((graph) => {
			const now = Date.now();
			const tasks = { ...graph.tasks };
			const bindings: Array<{
				agentId: string;
				runId: string;
				taskId: string;
			}> = [];
			const taskIds: string[] = [];
			for (const task of Object.values(tasks)) {
				if (task.status === "completed" || task.status === "cancelled") {
					continue;
				}
				if (task.ownerAgentId && task.activeRunId) {
					bindings.push({
						agentId: task.ownerAgentId,
						runId: task.activeRunId,
						taskId: task.id,
					});
				}
				tasks[task.id] = {
					...task,
					status: "cancelled",
					ownerAgentId: undefined,
					activeRunId: undefined,
					error: reason,
					version: task.version + 1,
					updatedAt: now,
				};
				taskIds.push(task.id);
			}
			return {
				graph: { ...graph, tasks },
				value: bindings,
				event:
					taskIds.length > 0
						? taskEvent("tasks_cancelled", taskIds, now)
						: undefined,
			};
		});
	}

	async validate(): Promise<TaskGraphValidation> {
		return validateTaskGraph(await this.readGraph());
	}

	private async readGraph(): Promise<TaskGraph> {
		if (this.graph) {
			return this.graph;
		}
		try {
			this.graph = parseTaskGraph(await readFile(this.path, "utf8"));
		} catch (caught) {
			if (!isNotFound(caught)) {
				throw caught;
			}
			this.graph = createEmptyTaskGraph();
		}
		return this.graph;
	}

	private async mutate<T>(
		operation: (graph: TaskGraph) => {
			graph: TaskGraph;
			value: T;
			event?: TaskStoreEvent;
		},
	): Promise<T> {
		return this.withLock(async () => {
			const current = await this.readGraph();
			const result = operation(current);
			if (result.graph !== current) {
				assertValidTaskGraph(result.graph);
				await this.persist(result.graph);
				this.graph = result.graph;
			}
			if (result.event) {
				this.emit(result.event);
			}
			return result.value;
		});
	}

	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.writeTail;
		let release!: () => void;
		this.writeTail = new Promise<void>((resolveRelease) => {
			release = resolveRelease;
		});
		await previous.catch(() => undefined);
		try {
			return await operation();
		} finally {
			release();
		}
	}

	private async persist(graph: TaskGraph): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(graph, null, 2)}\n`, {
				encoding: "utf8",
				flag: "wx",
			});
			await rename(temporary, this.path);
		} catch (caught) {
			try {
				await rm(temporary, { force: true });
			} catch {
				// Preserve the original persistence error.
			}
			throw caught;
		}
	}

	private emit(event: TaskStoreEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

export function createEmptyTaskGraph(): TaskGraph {
	return { tasks: {}, nextSequence: 1 };
}

export function parseTaskGraph(serialized: string | unknown): TaskGraph {
	const value =
		typeof serialized === "string"
			? (JSON.parse(serialized) as unknown)
			: serialized;
	const graph = taskGraphSchema.parse(value);
	for (const [id, task] of Object.entries(graph.tasks)) {
		if (id !== task.id) {
			throw new Error(`task graph key ${id} does not match task ID ${task.id}`);
		}
	}
	assertValidTaskGraph(graph);
	return graph;
}

export function createTaskGraphBatch(
	graph: TaskGraph,
	drafts: readonly TaskDraft[],
	now = Date.now(),
): { graph: TaskGraph; tasks: Task[] } {
	if (drafts.length === 0) {
		throw new Error("at least one task is required");
	}
	const clientIds = new Set<string>();
	for (const draft of drafts) {
		if (clientIds.has(draft.clientId)) {
			throw new Error(`duplicate client_id: ${draft.clientId}`);
		}
		clientIds.add(draft.clientId);
	}

	let nextSequence = graph.nextSequence;
	const allocated = new Map<string, string>();
	for (const draft of drafts) {
		let id: string;
		do {
			id = `task-${nextSequence++}`;
		} while (graph.tasks[id]);
		allocated.set(draft.clientId, id);
	}
	const created = drafts.map((draft) => {
		const id = allocated.get(draft.clientId);
		if (!id) {
			throw new Error(`failed to allocate task ID for ${draft.clientId}`);
		}
		return {
			id,
			subject: draft.subject,
			description: draft.description ?? "",
			status: "pending",
			blockedBy: unique(
				draft.blockedBy.map(
					(reference) => allocated.get(reference) ?? reference,
				),
			),
			blocks: [],
			attempt: 0,
			maxAttempts: draft.maxAttempts ?? 2,
			version: 1,
			createdAt: now,
			updatedAt: now,
			idempotencyKeys: [],
		} satisfies Task;
	});
	let candidate: TaskGraph = {
		tasks: { ...graph.tasks },
		nextSequence,
	};
	for (const task of created) {
		candidate.tasks[task.id] = task;
	}
	candidate = rebuildBlocks(candidate);
	assertValidTaskGraph(candidate);
	return { graph: candidate, tasks: created.map(cloneTask) };
}

export function isTaskReady(
	task: Task,
	tasks: Readonly<Record<string, Task>>,
): boolean {
	return (
		task.status === "pending" &&
		!task.ownerAgentId &&
		task.blockedBy.every((id) => tasks[id]?.status === "completed")
	);
}

export function validateTaskGraph(graph: TaskGraph): TaskGraphValidation {
	for (const task of Object.values(graph.tasks)) {
		for (const dependencyId of task.blockedBy) {
			if (dependencyId === task.id) {
				return {
					valid: false,
					reason: "self_dependency",
					taskId: task.id,
					dependencyId,
				};
			}
			const dependency = graph.tasks[dependencyId];
			if (!dependency) {
				return {
					valid: false,
					reason: "missing_dependency",
					taskId: task.id,
					dependencyId,
				};
			}
			if (!dependency.blocks.includes(task.id)) {
				return {
					valid: false,
					reason: "inconsistent_edge",
					taskId: task.id,
					dependencyId,
				};
			}
		}
		for (const childId of task.blocks) {
			if (!graph.tasks[childId]?.blockedBy.includes(task.id)) {
				return {
					valid: false,
					reason: "inconsistent_edge",
					taskId: task.id,
					dependencyId: childId,
				};
			}
		}
	}

	const visited = new Set<string>();
	const visiting = new Set<string>();
	const path: string[] = [];
	const visit = (taskId: string): string[] | undefined => {
		if (visiting.has(taskId)) {
			const start = path.indexOf(taskId);
			return [...path.slice(start), taskId];
		}
		if (visited.has(taskId)) {
			return undefined;
		}
		visiting.add(taskId);
		path.push(taskId);
		for (const dependencyId of graph.tasks[taskId]?.blockedBy ?? []) {
			const cycle = visit(dependencyId);
			if (cycle) {
				return cycle;
			}
		}
		path.pop();
		visiting.delete(taskId);
		visited.add(taskId);
		return undefined;
	};
	for (const taskId of Object.keys(graph.tasks)) {
		const cycle = visit(taskId);
		if (cycle) {
			return {
				valid: false,
				reason: "dependency_cycle",
				taskId,
				cycle,
			};
		}
	}
	return { valid: true };
}

export function collectDescendants(
	rootId: string,
	tasks: Readonly<Record<string, Task>>,
): string[] {
	const result: string[] = [];
	const visited = new Set<string>();
	const stack = [rootId];
	while (stack.length > 0) {
		const id = stack.pop();
		if (!id) {
			continue;
		}
		for (const childId of tasks[id]?.blocks ?? []) {
			if (visited.has(childId)) {
				continue;
			}
			visited.add(childId);
			result.push(childId);
			stack.push(childId);
		}
	}
	return result;
}

function cancelTasks(
	graph: TaskGraph,
	rootId: string,
	cascade: boolean,
	reason: string,
	idempotencyKey: string,
): {
	graph: TaskGraph;
	taskIds: string[];
	bindings: Array<{ agentId: string; runId: string; taskId: string }>;
} {
	const targets = cascade
		? [rootId, ...collectDescendants(rootId, graph.tasks)]
		: [rootId];
	const tasks = { ...graph.tasks };
	const taskIds: string[] = [];
	const bindings: Array<{ agentId: string; runId: string; taskId: string }> =
		[];
	const now = Date.now();
	for (const id of targets) {
		const task = tasks[id];
		if (!task || task.status === "completed" || task.status === "cancelled") {
			continue;
		}
		if (task.ownerAgentId && task.activeRunId) {
			bindings.push({
				agentId: task.ownerAgentId,
				runId: task.activeRunId,
				taskId: task.id,
			});
		}
		tasks[id] = {
			...task,
			status: "cancelled",
			ownerAgentId: undefined,
			activeRunId: undefined,
			error: reason,
			version: task.version + 1,
			idempotencyKeys:
				id === rootId
					? appendIdempotencyKey(task.idempotencyKeys, idempotencyKey)
					: task.idempotencyKeys,
			updatedAt: now,
		};
		taskIds.push(id);
	}
	return { graph: { ...graph, tasks }, taskIds, bindings };
}

function rebuildBlocks(graph: TaskGraph): TaskGraph {
	const tasks: Record<string, Task> = {};
	for (const task of Object.values(graph.tasks)) {
		tasks[task.id] = { ...task, blocks: [] };
	}
	for (const task of Object.values(tasks)) {
		for (const dependencyId of task.blockedBy) {
			const dependency = tasks[dependencyId];
			if (dependency && !dependency.blocks.includes(task.id)) {
				tasks[dependencyId] = {
					...dependency,
					blocks: [...dependency.blocks, task.id],
				};
			}
		}
	}
	return { ...graph, tasks };
}

function assertTaskActor(
	task: Task,
	actor: TaskActor,
	action: TaskUpdateRequest["action"],
): void {
	if (actor.isRoot) {
		return;
	}
	if (
		actor.taskId !== task.id ||
		actor.agentId !== task.ownerAgentId ||
		actor.runId !== task.activeRunId
	) {
		throw new Error(
			`agent ${actor.agentId} does not own active task ${task.id}`,
		);
	}
	if (action !== "progress") {
		throw new Error(
			"sub-agents may only report progress; the host finalizes tasks",
		);
	}
}

function assertValidTaskGraph(graph: TaskGraph): void {
	const validation = validateTaskGraph(graph);
	if (validation.valid) {
		return;
	}
	if (validation.reason === "dependency_cycle") {
		throw new Error(`dependency_cycle: ${validation.cycle?.join(" -> ")}`);
	}
	if (validation.reason === "self_dependency") {
		throw new Error(`task ${validation.taskId} cannot depend on itself`);
	}
	if (validation.reason === "missing_dependency") {
		throw new Error(
			`task ${validation.taskId} depends on missing task ${validation.dependencyId}`,
		);
	}
	throw new Error(
		`inconsistent task edge: ${validation.taskId} / ${validation.dependencyId}`,
	);
}

function replaceTask(graph: TaskGraph, task: Task): TaskGraph {
	return { ...graph, tasks: { ...graph.tasks, [task.id]: task } };
}

function requireTask(graph: TaskGraph, taskId: string): Task {
	const task = graph.tasks[taskId];
	if (!task) {
		throw new Error(`task not found: ${taskId}`);
	}
	return task;
}

function isActiveRun(
	task: Task | undefined,
	agentId: string,
	runId: string,
): task is Task {
	return (
		task?.status === "running" &&
		task.ownerAgentId === agentId &&
		task.activeRunId === runId
	);
}

function cloneTask(task: Task): Task {
	return {
		...task,
		blockedBy: task.blockedBy.slice(),
		blocks: task.blocks.slice(),
		idempotencyKeys: task.idempotencyKeys.slice(),
		result: task.result
			? {
					...task.result,
					artifacts: task.result.artifacts?.slice(),
				}
			: undefined,
	};
}

function appendIdempotencyKey(keys: readonly string[], key: string): string[] {
	return [...keys.slice(-9_999), key];
}

function taskEvent(
	type: TaskStoreEvent["type"],
	taskIds: string[],
	timestamp = Date.now(),
): TaskStoreEvent {
	return { type, taskIds, timestamp };
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function compareTaskIds(left: string, right: string): number {
	const leftNumber = /^task-(\d+)$/.exec(left)?.[1];
	const rightNumber = /^task-(\d+)$/.exec(right)?.[1];
	if (leftNumber && rightNumber) {
		return Number(leftNumber) - Number(rightNumber);
	}
	return left.localeCompare(right);
}

function isNotFound(caught: unknown): boolean {
	return (
		caught instanceof Error &&
		"code" in caught &&
		(caught as NodeJS.ErrnoException).code === "ENOENT"
	);
}
