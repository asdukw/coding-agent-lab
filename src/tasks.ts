import { randomUUID } from "node:crypto";
import { z } from "zod";

export const TASK_STATUSES = [
	"pending",
	"running",
	"succeeded",
	"failed",
	"cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskAction =
	| "progress"
	| "complete"
	| "fail"
	| "release"
	| "cancel"
	| "retry"
	| "add_dependencies";

export type TaskLease = {
	token: string;
	expiresAt: string;
};

export type TaskRecord = {
	id: string;
	subject: string;
	description?: string;
	status: TaskStatus;
	owner?: string;
	blockedBy: string[];
	progress?: string;
	result?: unknown;
	error?: string;
	lease?: TaskLease;
	version: number;
	attempts: number;
	idempotencyKeys: string[];
	createdAt: string;
	updatedAt: string;
};

export type TaskGraphState = {
	tasks: Record<string, TaskRecord>;
	nextSequence: number;
};

export type TaskDraft = {
	clientId: string;
	subject: string;
	description?: string;
	blockedBy: string[];
};

export type TaskUpdateRequest = {
	taskId: string;
	action: TaskAction;
	expectedVersion: number;
	idempotencyKey: string;
	agentId?: string;
	leaseToken?: string;
	progress?: string;
	result?: unknown;
	error?: string;
	blockedBy?: string[];
};

export type TaskUpdateResult = {
	graph: TaskGraphState;
	task: TaskRecord;
	idempotentReplay: boolean;
};

export type TaskGraphValidation =
	| { valid: true }
	| {
			valid: false;
			reason: "missing_dependency" | "self_dependency" | "dependency_cycle";
			taskId: string;
			dependencyId?: string;
			cycle?: string[];
	  };

const taskRecordSchema: z.ZodType<TaskRecord> = z
	.object({
		id: z.string().regex(/^task-[1-9]\d*$/),
		subject: z.string().min(1).max(200),
		description: z.string().max(20_000).optional(),
		status: z.enum(TASK_STATUSES),
		owner: z.string().min(1).max(200).optional(),
		blockedBy: z.array(z.string().regex(/^task-[1-9]\d*$/)).max(100),
		progress: z.string().max(20_000).optional(),
		result: z.unknown().optional(),
		error: z.string().max(20_000).optional(),
		lease: z
			.object({
				token: z.string().uuid(),
				expiresAt: z.iso.datetime(),
			})
			.strict()
			.optional(),
		version: z.number().int().positive(),
		attempts: z.number().int().nonnegative(),
		idempotencyKeys: z.array(z.string().min(1).max(200)).max(10_000),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime(),
	})
	.strict();

const taskGraphSchema = z
	.object({
		tasks: z.record(z.string(), taskRecordSchema),
		nextSequence: z.number().int().positive(),
	})
	.strict();

export function createEmptyTaskGraph(): TaskGraphState {
	return { tasks: {}, nextSequence: 1 };
}

export function normalizeTaskGraph(value: unknown): TaskGraphState {
	if (value === undefined) {
		return createEmptyTaskGraph();
	}
	try {
		return parseTaskGraph(value);
	} catch {
		return createEmptyTaskGraph();
	}
}

export function parseTaskGraph(value: unknown): TaskGraphState {
	const graph = taskGraphSchema.parse(value);
	for (const [id, task] of Object.entries(graph.tasks)) {
		if (id !== task.id) {
			throw new Error(`task graph key ${id} does not match task ID ${task.id}`);
		}
	}
	const validation = validateTaskGraph(graph);
	if (!validation.valid) {
		throw new Error(`invalid persisted task graph: ${validation.reason}`);
	}
	return graph;
}

export function createTaskGraphBatch(
	graph: TaskGraphState,
	drafts: readonly TaskDraft[],
	now = new Date().toISOString(),
): { graph: TaskGraphState; tasks: TaskRecord[] } {
	if (drafts.length === 0) {
		throw new Error("at least one task is required");
	}

	const seenClientIds = new Set<string>();
	for (const draft of drafts) {
		if (seenClientIds.has(draft.clientId)) {
			throw new Error(`duplicate client_id: ${draft.clientId}`);
		}
		seenClientIds.add(draft.clientId);
	}

	let nextSequence = graph.nextSequence;
	const clientIdToTaskId = new Map<string, string>();
	for (const draft of drafts) {
		let taskId: string;
		do {
			taskId = `task-${nextSequence++}`;
		} while (graph.tasks[taskId]);
		clientIdToTaskId.set(draft.clientId, taskId);
	}

	const created = drafts.map((draft) => {
		const id = clientIdToTaskId.get(draft.clientId);
		if (!id) {
			throw new Error(`failed to allocate task ID for ${draft.clientId}`);
		}
		const blockedBy = unique(
			draft.blockedBy.map(
				(reference) => clientIdToTaskId.get(reference) ?? reference,
			),
		);
		return {
			id,
			subject: draft.subject,
			description: draft.description,
			status: "pending",
			blockedBy,
			version: 1,
			attempts: 0,
			idempotencyKeys: [],
			createdAt: now,
			updatedAt: now,
		} satisfies TaskRecord;
	});

	const candidate: TaskGraphState = {
		tasks: { ...graph.tasks },
		nextSequence,
	};
	for (const task of created) {
		candidate.tasks[task.id] = task;
	}
	assertValidTaskGraph(candidate);
	return { graph: candidate, tasks: created };
}

export function claimTask(
	graph: TaskGraphState,
	taskId: string,
	agentId: string,
	leaseMs: number,
	now = new Date(),
): { graph: TaskGraphState; task: TaskRecord } {
	if (
		!Number.isSafeInteger(leaseMs) ||
		leaseMs < 1_000 ||
		leaseMs > 3_600_000
	) {
		throw new Error("lease duration must be between 1000 and 3600000 ms");
	}
	const recovered = recoverExpiredLeases(graph, now);
	const activeGraph = recovered.graph;
	const task = requireTask(activeGraph, taskId);
	if (task.status !== "pending") {
		throw new Error(`task ${taskId} is ${task.status}, not pending`);
	}
	if (task.owner) {
		throw new Error(`task ${taskId} is already owned by ${task.owner}`);
	}
	const blockers = task.blockedBy.filter(
		(id) => activeGraph.tasks[id]?.status !== "succeeded",
	);
	if (blockers.length > 0) {
		throw new Error(`task ${taskId} is blocked by: ${blockers.join(", ")}`);
	}

	const updated: TaskRecord = {
		...task,
		status: "running",
		owner: agentId,
		lease: {
			token: randomUUID(),
			expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
		},
		attempts: task.attempts + 1,
		version: task.version + 1,
		updatedAt: now.toISOString(),
	};
	return { graph: replaceTask(activeGraph, updated), task: updated };
}

export function recoverExpiredLeases(
	graph: TaskGraphState,
	now = new Date(),
): { graph: TaskGraphState; recoveredTaskIds: string[] } {
	let tasks: Record<string, TaskRecord> | undefined;
	const recoveredTaskIds: string[] = [];
	for (const task of Object.values(graph.tasks)) {
		if (
			task.status !== "running" ||
			!task.lease ||
			Date.parse(task.lease.expiresAt) > now.getTime()
		) {
			continue;
		}
		tasks ??= { ...graph.tasks };
		tasks[task.id] = {
			...task,
			status: "pending",
			owner: undefined,
			lease: undefined,
			version: task.version + 1,
			updatedAt: now.toISOString(),
		};
		recoveredTaskIds.push(task.id);
	}
	return {
		graph: tasks ? { ...graph, tasks } : graph,
		recoveredTaskIds,
	};
}

export function updateTaskGraph(
	graph: TaskGraphState,
	request: TaskUpdateRequest,
	now = new Date(),
): TaskUpdateResult {
	const task = requireTask(graph, request.taskId);
	if (task.idempotencyKeys.includes(request.idempotencyKey)) {
		return { graph, task, idempotentReplay: true };
	}
	if (task.version !== request.expectedVersion) {
		throw new Error(
			`task ${task.id} version conflict: expected ${request.expectedVersion}, current ${task.version}`,
		);
	}

	const timestamp = now.toISOString();
	let updated: TaskRecord;
	switch (request.action) {
		case "progress":
			assertRunningLease(task, request, now);
			if (!request.progress?.trim()) {
				throw new Error("progress action requires a non-empty progress value");
			}
			updated = { ...task, progress: request.progress.trim() };
			break;
		case "complete":
			assertRunningLease(task, request, now);
			updated = {
				...task,
				status: "succeeded",
				result: request.result,
				owner: undefined,
				lease: undefined,
				error: undefined,
			};
			break;
		case "fail":
			assertRunningLease(task, request, now);
			if (!request.error?.trim()) {
				throw new Error("fail action requires a non-empty error value");
			}
			updated = {
				...task,
				status: "failed",
				error: request.error.trim(),
				owner: undefined,
				lease: undefined,
			};
			break;
		case "release":
			assertRunningLease(task, request, now);
			updated = {
				...task,
				status: "pending",
				owner: undefined,
				lease: undefined,
			};
			break;
		case "cancel":
			if (task.status === "running") {
				assertRunningLease(task, request, now);
			} else if (task.status !== "pending") {
				throw new Error(`cannot cancel task ${task.id} from ${task.status}`);
			}
			updated = {
				...task,
				status: "cancelled",
				owner: undefined,
				lease: undefined,
			};
			break;
		case "retry":
			if (task.status !== "failed") {
				throw new Error(`cannot retry task ${task.id} from ${task.status}`);
			}
			updated = {
				...task,
				status: "pending",
				error: undefined,
				progress: undefined,
				result: undefined,
			};
			break;
		case "add_dependencies": {
			if (task.status !== "pending" || task.owner) {
				throw new Error(
					"dependencies can only be added to an unowned pending task",
				);
			}
			if (!request.blockedBy?.length) {
				throw new Error("add_dependencies requires blocked_by");
			}
			updated = {
				...task,
				blockedBy: unique([...task.blockedBy, ...request.blockedBy]),
			};
			const candidate = replaceTask(graph, {
				...updated,
				version: task.version + 1,
				idempotencyKeys: appendIdempotencyKey(
					task.idempotencyKeys,
					request.idempotencyKey,
				),
				updatedAt: timestamp,
			});
			assertValidTaskGraph(candidate);
			return {
				graph: candidate,
				task: candidate.tasks[task.id] as TaskRecord,
				idempotentReplay: false,
			};
		}
	}

	updated = {
		...updated,
		version: task.version + 1,
		idempotencyKeys: appendIdempotencyKey(
			task.idempotencyKeys,
			request.idempotencyKey,
		),
		updatedAt: timestamp,
	};
	return {
		graph: replaceTask(graph, updated),
		task: updated,
		idempotentReplay: false,
	};
}

export function listTasks(
	graph: TaskGraphState,
	filter: {
		readyOnly?: boolean;
		status?: readonly TaskStatus[];
		unownedOnly?: boolean;
	} = {},
): TaskRecord[] {
	return Object.values(graph.tasks)
		.filter((task) => !filter.status || filter.status.includes(task.status))
		.filter((task) => !filter.unownedOnly || !task.owner)
		.filter((task) => !filter.readyOnly || isTaskReady(task, graph.tasks))
		.sort((left, right) => compareTaskIds(left.id, right.id));
}

export function isTaskReady(
	task: TaskRecord,
	tasks: Readonly<Record<string, TaskRecord>>,
): boolean {
	return (
		task.status === "pending" &&
		!task.owner &&
		task.blockedBy.every((id) => tasks[id]?.status === "succeeded")
	);
}

export function validateTaskGraph(graph: TaskGraphState): TaskGraphValidation {
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
			if (!graph.tasks[dependencyId]) {
				return {
					valid: false,
					reason: "missing_dependency",
					taskId: task.id,
					dependencyId,
				};
			}
		}
	}

	const visited = new Set<string>();
	const visiting = new Set<string>();
	const path: string[] = [];
	const visit = (taskId: string): string[] | undefined => {
		if (visiting.has(taskId)) {
			const cycleStart = path.indexOf(taskId);
			return [...path.slice(cycleStart), taskId];
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

function assertValidTaskGraph(graph: TaskGraphState): void {
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
	throw new Error(
		`task ${validation.taskId} depends on missing task ${validation.dependencyId}`,
	);
}

function assertRunningLease(
	task: TaskRecord,
	request: Pick<TaskUpdateRequest, "agentId" | "leaseToken">,
	now: Date,
): void {
	if (task.status !== "running") {
		throw new Error(`task ${task.id} is ${task.status}, not running`);
	}
	if (!request.agentId || task.owner !== request.agentId) {
		throw new Error(`task ${task.id} owner mismatch`);
	}
	if (!request.leaseToken || task.lease?.token !== request.leaseToken) {
		throw new Error(`task ${task.id} lease token mismatch`);
	}
	if (Date.parse(task.lease.expiresAt) <= now.getTime()) {
		throw new Error(`task ${task.id} lease expired`);
	}
}

function replaceTask(graph: TaskGraphState, task: TaskRecord): TaskGraphState {
	return {
		...graph,
		tasks: { ...graph.tasks, [task.id]: task },
	};
}

function requireTask(graph: TaskGraphState, taskId: string): TaskRecord {
	const task = graph.tasks[taskId];
	if (!task) {
		throw new Error(`task not found: ${taskId}`);
	}
	return task;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function appendIdempotencyKey(keys: readonly string[], key: string): string[] {
	return [...keys.slice(-9_999), key];
}

function compareTaskIds(left: string, right: string): number {
	const leftNumber = /^task-(\d+)$/.exec(left)?.[1];
	const rightNumber = /^task-(\d+)$/.exec(right)?.[1];
	if (leftNumber && rightNumber) {
		return Number(leftNumber) - Number(rightNumber);
	}
	return left.localeCompare(right);
}
