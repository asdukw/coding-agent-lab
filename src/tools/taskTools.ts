import { z } from "zod";
import {
	claimTask,
	createTaskGraphBatch,
	listTasks,
	recoverExpiredLeases,
	TASK_STATUSES,
	type TaskAction,
	type TaskGraphState,
	type TaskStatus,
	updateTaskGraph,
} from "../tasks";
import { sessionResourceAccess } from "./resourceLock";
import type { Tool, ToolContext, Tools } from "./types";

export const TASK_CREATE_TOOL_NAME = "TaskCreate";
export const TASK_GET_TOOL_NAME = "TaskGet";
export const TASK_LIST_TOOL_NAME = "TaskList";
export const TASK_CLAIM_TOOL_NAME = "TaskClaim";
export const TASK_UPDATE_TOOL_NAME = "TaskUpdate";

const taskIdSchema = z.string().regex(/^task-[1-9]\d*$/);
const clientIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

function requireContext(context: ToolContext | undefined): ToolContext {
	if (!context) {
		throw new Error("task tool context is required");
	}
	return context;
}

function graphFrom(context: ToolContext): TaskGraphState {
	return context.getState().taskGraph;
}

function sessionAccess(
	context: ToolContext | undefined,
	mode: "read" | "write",
) {
	return [
		sessionResourceAccess(requireContext(context).getState().sessionId, mode),
	];
}

const createInputSchema = z
	.object({
		tasks: z
			.array(
				z
					.object({
						client_id: clientIdSchema,
						subject: z.string().trim().min(1).max(200),
						description: z.string().trim().min(1).max(20_000).optional(),
						blocked_by: z.array(z.string().min(1)).max(100).default([]),
					})
					.strict(),
			)
			.min(1)
			.max(100),
	})
	.strict();

export const taskCreateTool: Tool<
	z.infer<typeof createInputSchema>,
	{ tasks: Array<{ client_id: string; id: string; subject: string }> }
> = {
	name: TASK_CREATE_TOOL_NAME,
	description:
		"Atomically create a task DAG. blocked_by may reference a client_id in this batch or an existing task ID; missing, self, and cyclic dependencies are rejected before state changes.",
	inputSchema: createInputSchema,
	getResourceAccesses(_input, context) {
		return sessionAccess(context, "write");
	},
	async call({ tasks }, context) {
		const toolContext = requireContext(context);
		const result = createTaskGraphBatch(
			graphFrom(toolContext),
			tasks.map((task) => ({
				clientId: task.client_id,
				subject: task.subject,
				description: task.description,
				blockedBy: task.blocked_by,
			})),
		);
		toolContext.setState((state) => ({ ...state, taskGraph: result.graph }));
		return {
			tasks: result.tasks.map((task, index) => ({
				client_id: tasks[index]?.client_id ?? "",
				id: task.id,
				subject: task.subject,
			})),
		};
	},
};

const getInputSchema = z.object({ task_id: taskIdSchema }).strict();

export const taskGetTool: Tool<
	z.infer<typeof getInputSchema>,
	{ task: TaskGraphState["tasks"][string] }
> = {
	name: TASK_GET_TOOL_NAME,
	description:
		"Get one task including status, owner, dependencies, result, version, and lease.",
	inputSchema: getInputSchema,
	getResourceAccesses(_input, context) {
		return sessionAccess(context, "read");
	},
	async call({ task_id }, context) {
		const task = graphFrom(requireContext(context)).tasks[task_id];
		if (!task) {
			throw new Error(`task not found: ${task_id}`);
		}
		return { task };
	},
};

const listInputSchema = z
	.object({
		ready_only: z.boolean().optional(),
		status: z.array(z.enum(TASK_STATUSES)).optional(),
		unowned_only: z.boolean().optional(),
	})
	.strict();

export const taskListTool: Tool<
	z.infer<typeof listInputSchema>,
	{ tasks: ReturnType<typeof listTasks> }
> = {
	name: TASK_LIST_TOOL_NAME,
	description:
		"List tasks with deterministic ready-state calculation from task status, owner, and succeeded dependencies.",
	inputSchema: listInputSchema,
	getResourceAccesses(_input, context) {
		return sessionAccess(context, "write");
	},
	async call({ ready_only, status, unowned_only }, context) {
		const toolContext = requireContext(context);
		const recovered = recoverExpiredLeases(graphFrom(toolContext));
		if (recovered.recoveredTaskIds.length > 0) {
			toolContext.setState((state) => ({
				...state,
				taskGraph: recovered.graph,
			}));
		}
		return {
			tasks: listTasks(recovered.graph, {
				readyOnly: ready_only,
				status: status as TaskStatus[] | undefined,
				unownedOnly: unowned_only,
			}),
		};
	},
};

const claimInputSchema = z
	.object({
		task_id: taskIdSchema,
		agent_id: z.string().trim().min(1).max(200),
		lease_ms: z.number().int().min(1_000).max(3_600_000).default(300_000),
	})
	.strict();

export const taskClaimTool: Tool<
	z.infer<typeof claimInputSchema>,
	{ task: TaskGraphState["tasks"][string] }
> = {
	name: TASK_CLAIM_TOOL_NAME,
	description:
		"Atomically claim a ready pending task, assigning its owner and creating a bounded lease token.",
	inputSchema: claimInputSchema,
	getResourceAccesses(_input, context) {
		return sessionAccess(context, "write");
	},
	async call({ task_id, agent_id, lease_ms }, context) {
		const toolContext = requireContext(context);
		const result = claimTask(
			graphFrom(toolContext),
			task_id,
			agent_id,
			lease_ms,
		);
		toolContext.setState((state) => ({ ...state, taskGraph: result.graph }));
		return { task: result.task };
	},
};

const updateInputSchema = z
	.object({
		task_id: taskIdSchema,
		action: z.enum([
			"progress",
			"complete",
			"fail",
			"release",
			"cancel",
			"retry",
			"add_dependencies",
		]),
		expected_version: z.number().int().positive(),
		idempotency_key: z.string().trim().min(1).max(200),
		agent_id: z.string().trim().min(1).max(200).optional(),
		lease_token: z.string().uuid().optional(),
		progress: z.string().max(20_000).optional(),
		result: z.unknown().optional(),
		error: z.string().max(20_000).optional(),
		blocked_by: z.array(taskIdSchema).max(100).optional(),
	})
	.strict();

export const taskUpdateTool: Tool<
	z.infer<typeof updateInputSchema>,
	{
		task: TaskGraphState["tasks"][string];
		idempotent_replay: boolean;
	}
> = {
	name: TASK_UPDATE_TOOL_NAME,
	description:
		"Apply an explicit task state transition with owner, lease, expected-version, and idempotency checks. add_dependencies validates the complete candidate graph with DFS before committing.",
	inputSchema: updateInputSchema,
	getResourceAccesses(_input, context) {
		return sessionAccess(context, "write");
	},
	async call(input, context) {
		const toolContext = requireContext(context);
		const result = updateTaskGraph(graphFrom(toolContext), {
			taskId: input.task_id,
			action: input.action as TaskAction,
			expectedVersion: input.expected_version,
			idempotencyKey: input.idempotency_key,
			agentId: input.agent_id,
			leaseToken: input.lease_token,
			progress: input.progress,
			result: input.result,
			error: input.error,
			blockedBy: input.blocked_by,
		});
		if (!result.idempotentReplay) {
			toolContext.setState((state) => ({ ...state, taskGraph: result.graph }));
		}
		return {
			task: result.task,
			idempotent_replay: result.idempotentReplay,
		};
	},
};

export const TASK_TOOLS: Tools = [
	taskCreateTool,
	taskGetTool,
	taskListTool,
	taskClaimTool,
	taskUpdateTool,
];
