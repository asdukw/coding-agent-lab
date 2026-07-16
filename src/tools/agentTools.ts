import { z } from "zod";
import type { AgentRuntime } from "../agents/types";
import {
	CANCEL_AGENT_TOOL_NAME,
	LIST_AGENTS_TOOL_NAME,
	SEND_AGENT_MESSAGE_TOOL_NAME,
	SPAWN_SUBAGENT_TOOL_NAME,
	WAIT_AGENT_TOOL_NAME,
} from "./agentToolNames";
import type { Tool, ToolContext, Tools } from "./types";

const noRuntimeResourceAccess = () => [];

const spawnInputSchema = z.object({
	task: z.string().min(1).describe("Concrete task delegated to the sub-agent"),
	description: z
		.string()
		.optional()
		.describe("Short human-readable description of the delegated task"),
	agent_type: z
		.enum(["general-purpose", "explore", "plan", "verify"])
		.optional()
		.describe("Specialized sub-agent type; defaults to general-purpose"),
	name: z
		.string()
		.optional()
		.describe("Optional unique name used to address the running agent"),
	run_in_background: z
		.boolean()
		.optional()
		.describe(
			"Return immediately and notify the parent when the agent completes",
		),
	context_mode: z
		.enum(["task-only", "fork"])
		.optional()
		.describe(
			"task-only passes structured runtime context; fork also includes recent parent conversation without raw tool outputs",
		),
	max_turns: z.number().int().min(1).max(50).optional(),
});

export const spawnSubagentTool: Tool<
	z.infer<typeof spawnInputSchema>,
	Awaited<ReturnType<AgentRuntime["spawn"]>>
> = {
	name: SPAWN_SUBAGENT_TOOL_NAME,
	description:
		"Launch an isolated in-process sub-agent. Multiple calls in one response run concurrently when their resources do not conflict.",
	inputSchema: spawnInputSchema,
	getResourceAccesses: noRuntimeResourceAccess,
	async call(input, context) {
		const runtime = requireRuntime(context);
		const state = requireState(context);
		return runtime.spawn(state, {
			task: input.task,
			description: input.description,
			agentType: input.agent_type,
			name: input.name,
			runInBackground: input.run_in_background,
			contextMode: input.context_mode,
			maxTurns: input.max_turns,
		});
	},
};

const listInputSchema = z.object({});

export const listAgentsTool: Tool<
	z.infer<typeof listInputSchema>,
	ReturnType<AgentRuntime["list"]>
> = {
	name: LIST_AGENTS_TOOL_NAME,
	description:
		"List sub-agents in the current session and their lifecycle state",
	inputSchema: listInputSchema,
	getResourceAccesses: noRuntimeResourceAccess,
	async call(_input, context) {
		return requireRuntime(context).list(requireState(context));
	},
};

const waitInputSchema = z.object({
	agent_id: z.string().min(1),
	timeout_ms: z.number().int().min(1).max(600_000).optional(),
});

export const waitAgentTool: Tool<
	z.infer<typeof waitInputSchema>,
	Awaited<ReturnType<AgentRuntime["wait"]>>
> = {
	name: WAIT_AGENT_TOOL_NAME,
	description:
		"Wait for a foreground or background sub-agent and return its result",
	inputSchema: waitInputSchema,
	getResourceAccesses: noRuntimeResourceAccess,
	async call(input, context) {
		return requireRuntime(context).wait(
			requireState(context),
			input.agent_id,
			input.timeout_ms,
			context?.signal,
		);
	},
};

const sendInputSchema = z.object({
	agent_id: z.string().min(1),
	message: z.string().min(1),
});

export const sendAgentMessageTool: Tool<
	z.infer<typeof sendInputSchema>,
	ReturnType<AgentRuntime["send"]>
> = {
	name: SEND_AGENT_MESSAGE_TOOL_NAME,
	description:
		"Send additional instructions to a running sub-agent; delivery occurs at the next safe query boundary",
	inputSchema: sendInputSchema,
	getResourceAccesses: noRuntimeResourceAccess,
	async call(input, context) {
		return requireRuntime(context).send(
			requireState(context),
			input.agent_id,
			input.message,
		);
	},
};

const cancelInputSchema = z.object({
	agent_id: z.string().min(1),
	reason: z.string().optional(),
});

export const cancelAgentTool: Tool<
	z.infer<typeof cancelInputSchema>,
	{ cancelled: boolean }
> = {
	name: CANCEL_AGENT_TOOL_NAME,
	description: "Cancel a running or queued sub-agent",
	inputSchema: cancelInputSchema,
	getResourceAccesses: noRuntimeResourceAccess,
	async call(input, context) {
		return {
			cancelled: await requireRuntime(context).cancel(
				requireState(context),
				input.agent_id,
				input.reason,
			),
		};
	},
};

export const AGENT_TOOLS: Tools = [
	spawnSubagentTool,
	listAgentsTool,
	waitAgentTool,
	sendAgentMessageTool,
	cancelAgentTool,
];

function requireRuntime(context: ToolContext | undefined): AgentRuntime {
	if (!context?.agentRuntime) {
		throw new Error("agent runtime is unavailable");
	}
	return context.agentRuntime;
}

function requireState(context: ToolContext | undefined) {
	if (!context) {
		throw new Error("agent tool requires a query state context");
	}
	return context.getState();
}
