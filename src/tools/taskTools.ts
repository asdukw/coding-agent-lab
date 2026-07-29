import { z } from "zod";
import type { TaskRuntime } from "../agents/types";
import { TASK_STATUSES, type TaskStatus } from "../tasks";
import type { Tool, ToolContext, Tools } from "./types";

export const TASK_CREATE_TOOL_NAME = "TaskCreate";
export const TASK_GET_TOOL_NAME = "TaskGet";
export const TASK_LIST_TOOL_NAME = "TaskList";
export const TASK_UPDATE_TOOL_NAME = "TaskUpdate";

const taskIdSchema = z.string().regex(/^task-[1-9]\d*$/);
const clientIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const noResourceAccess = () => [];

function requireContext(context: ToolContext | undefined): ToolContext {
	if (!context) {
		throw new Error("task tool context is required");
	}
	return context;
}

function requireRuntime(context: ToolContext | undefined): {
	context: ToolContext;
	tasks: TaskRuntime;
} {
	const toolContext = requireContext(context);
	if (!toolContext.agentRuntime?.tasks) {
		throw new Error("task runtime is unavailable");
	}
	return {
		context: toolContext,
		tasks: toolContext.agentRuntime.tasks,
	};
}

const createInputSchema = z
	.object({
		tasks: z
			.array(
				z
					.object({
						client_id: clientIdSchema,
						subject: z.string().trim().min(1).max(200),
						description: z.string().trim().max(20_000).default(""),
						blocked_by: z.array(z.string().min(1)).max(100).default([]),
						max_attempts: z.number().int().min(1).max(10).default(2),
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
		"Atomically create a persistent task DAG. The host validates all dependencies and cycles, then automatically schedules ready tasks.",
	inputSchema: createInputSchema,
	getResourceAccesses: noResourceAccess,
	async call({ tasks }, context) {
		const { context: toolContext, tasks: taskRuntime } =
			requireRuntime(context);
		const created = await taskRuntime.create(
			toolContext.getState(),
			tasks.map((task) => ({
				clientId: task.client_id,
				subject: task.subject,
				description: task.description,
				blockedBy: task.blocked_by,
				maxAttempts: task.max_attempts,
			})),
		);
		return {
			tasks: created.map((task, index) => ({
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
	{ task: Awaited<ReturnType<TaskRuntime["get"]>> }
> = {
	name: TASK_GET_TOOL_NAME,
	description:
		"Get one persistent task including dependencies, ownerAgentId, activeRunId, attempts, result, and version.",
	inputSchema: getInputSchema,
	getResourceAccesses: noResourceAccess,
	async call({ task_id }, context) {
		const { context: toolContext, tasks } = requireRuntime(context);
		const task = await tasks.get(toolContext.getState(), task_id);
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
	{ tasks: Awaited<ReturnType<TaskRuntime["list"]>> }
> = {
	name: TASK_LIST_TOOL_NAME,
	description:
		"List persistent tasks. Ready state is computed by the host from pending status, no owner, and completed dependencies.",
	inputSchema: listInputSchema,
	getResourceAccesses: noResourceAccess,
	async call({ ready_only, status, unowned_only }, context) {
		const { context: toolContext, tasks } = requireRuntime(context);
		return {
			tasks: await tasks.list(toolContext.getState(), {
				readyOnly: ready_only,
				status: status as TaskStatus[] | undefined,
				unownedOnly: unowned_only,
			}),
		};
	},
};

const updateInputSchema = z
	.object({
		task_id: taskIdSchema,
		action: z.enum(["progress", "retry", "cancel", "add_dependencies"]),
		expected_version: z.number().int().positive(),
		idempotency_key: z.string().trim().min(1).max(200),
		progress: z.string().max(20_000).optional(),
		blocked_by: z.array(taskIdSchema).max(100).optional(),
		reason: z.string().trim().max(20_000).optional(),
		cascade: z.boolean().optional(),
	})
	.strict();

export const taskUpdateTool: Tool<
	z.infer<typeof updateInputSchema>,
	{
		task: Awaited<ReturnType<TaskRuntime["get"]>>;
		idempotent_replay: boolean;
	}
> = {
	name: TASK_UPDATE_TOOL_NAME,
	description:
		"Report progress or request a deterministic task mutation. Sub-agents may only report progress for their active run; the host alone finalizes Agent results. Main may retry, cancel with downward propagation, or add DFS-validated dependencies.",
	inputSchema: updateInputSchema,
	getResourceAccesses: noResourceAccess,
	async call(input, context) {
		const { context: toolContext, tasks } = requireRuntime(context);
		const outcome = await tasks.update(toolContext.getState(), {
			taskId: input.task_id,
			action: input.action,
			expectedVersion: input.expected_version,
			idempotencyKey: input.idempotency_key,
			progress: input.progress,
			blockedBy: input.blocked_by,
			reason: input.reason,
			cascade: input.cascade,
		});
		return {
			task: outcome.task,
			idempotent_replay: outcome.idempotentReplay,
		};
	},
};

export const TASK_TOOLS: Tools = [
	taskCreateTool,
	taskGetTool,
	taskListTool,
	taskUpdateTool,
];
