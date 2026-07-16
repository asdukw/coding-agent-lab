import type { ModelClient } from "../model/client";
import { query, type Terminal } from "../query";
import {
	type AgentState,
	createInitialState,
	createToolPermissionContext,
	type Message,
} from "../state";
import {
	CANCEL_AGENT_TOOL_NAME,
	SPAWN_SUBAGENT_TOOL_NAME,
	WAIT_AGENT_TOOL_NAME,
} from "../tools/agentToolNames";
import {
	ENTER_PLAN_MODE_TOOL_NAME,
	EXIT_PLAN_MODE_TOOL_NAME,
	UPDATE_PLAN_TOOL_NAME,
} from "../tools/planToolNames";
import type { Tools } from "../tools/types";
import { toToolSpecs } from "../tools/types";
import type { AgentIdentity } from "./identity";
import type { AgentContextMode, AgentResult, AgentRuntime } from "./types";

const READ_ONLY_TOOL_NAMES = new Set([
	"Read",
	"Glob",
	"Grep",
	"ListAgents",
	"SendAgentMessage",
]);

export async function runSubagent(params: {
	identity: AgentIdentity;
	parentState: AgentState;
	task: string;
	contextMode: AgentContextMode;
	model: ModelClient;
	tools: Tools;
	agentRuntime: AgentRuntime;
	maxTurns: number;
	signal: AbortSignal;
}): Promise<AgentResult> {
	const tools = toolsForAgent(params.identity, params.tools);
	const initialState = createChildState({ ...params, tools });
	const inheritedExecutionIds = new Set(
		params.parentState.toolExecutions.map((execution) => execution.callId),
	);
	let latestState = initialState;
	let terminal: Terminal | undefined;

	try {
		for await (const event of query({
			initialState,
			model: params.model,
			tools,
			enableMemoryExtraction: false,
			agentRuntime: params.agentRuntime,
			signal: params.signal,
		})) {
			if (event.type === "state" || event.type === "compaction") {
				latestState = event.state;
			} else if (event.type === "terminal") {
				terminal = event.terminal;
				latestState = event.terminal.state;
			}
		}
	} catch (caught) {
		const error = formatCaught(caught);
		return resultFromState({
			agentId: params.identity.id,
			state: latestState,
			inheritedExecutionIds,
			status: params.signal.aborted ? "cancelled" : "failed",
			summary: params.signal.aborted
				? `Sub-agent cancelled: ${error}`
				: `Sub-agent failed: ${error}`,
			error,
		});
	}

	if (!terminal) {
		return resultFromState({
			agentId: params.identity.id,
			state: latestState,
			inheritedExecutionIds,
			status: "failed",
			summary: "Sub-agent query ended without a terminal result.",
			error: "missing terminal result",
		});
	}

	if (terminal.reason !== "complete") {
		return resultFromState({
			agentId: params.identity.id,
			state: terminal.state,
			inheritedExecutionIds,
			status: "failed",
			summary: `Sub-agent stopped: ${terminal.reason}`,
			error: terminal.reason,
		});
	}

	return resultFromState({
		agentId: params.identity.id,
		state: terminal.state,
		inheritedExecutionIds,
		status: "completed",
		summary: terminal.state.finalAnswer?.trim() || "Sub-agent completed.",
	});
}

function createChildState(params: {
	identity: AgentIdentity;
	parentState: AgentState;
	task: string;
	contextMode: AgentContextMode;
	tools: Tools;
	maxTurns: number;
}): AgentState {
	const childSessionId = `${params.parentState.sessionId}.agent.${params.identity.id}`;
	const state = createInitialState(
		params.task,
		params.parentState.cwd,
		toToolSpecs(params.tools),
		childSessionId,
	);
	const inheritedMessages =
		params.contextMode === "fork"
			? forkableMessages(params.parentState.messages)
			: [];

	return {
		...state,
		agent: params.identity,
		toolPermissionContext: createToolPermissionContext(params.parentState.cwd, {
			agentType: "subagent",
			writePolicy: params.parentState.toolPermissionContext.writePolicy,
		}),
		messages: [
			{
				role: "system",
				content: buildSubagentContext(params.identity, params.parentState),
			},
			...inheritedMessages,
			{ role: "user", content: params.task },
		],
		plan: {
			explanation: params.parentState.plan.explanation,
			items: params.parentState.plan.items.map((item) => ({ ...item })),
		},
		toolExecutions: params.parentState.toolExecutions.slice(),
		changedFiles: [],
		maxTurns: params.maxTurns,
		budget: { turnsUsed: 0, maxTurns: params.maxTurns },
	};
}

function toolsForAgent(identity: AgentIdentity, tools: Tools): Tools {
	const childTools = tools.filter(
		(tool) =>
			tool.name !== SPAWN_SUBAGENT_TOOL_NAME &&
			tool.name !== WAIT_AGENT_TOOL_NAME &&
			tool.name !== CANCEL_AGENT_TOOL_NAME &&
			tool.name !== ENTER_PLAN_MODE_TOOL_NAME &&
			tool.name !== EXIT_PLAN_MODE_TOOL_NAME &&
			tool.name !== UPDATE_PLAN_TOOL_NAME,
	);
	if (
		identity.type === "explore" ||
		identity.type === "plan" ||
		identity.type === "verify"
	) {
		return childTools.filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.name));
	}
	return childTools;
}

function resultFromState(params: {
	agentId: string;
	state: AgentState;
	inheritedExecutionIds: ReadonlySet<string>;
	status: AgentResult["status"];
	summary: string;
	error?: string;
}): AgentResult {
	return {
		agentId: params.agentId,
		status: params.status,
		summary: params.summary,
		changedFiles: params.state.changedFiles.slice(),
		toolExecutions: params.state.toolExecutions.filter(
			(execution) => !params.inheritedExecutionIds.has(execution.callId),
		),
		turnsUsed: params.state.budget.turnsUsed,
		error: params.error,
	};
}

function formatCaught(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}

function forkableMessages(messages: readonly Message[]): Message[] {
	return messages
		.filter(
			(message) =>
				message.role !== "tool" &&
				!(message.role === "assistant" && message.toolCalls?.length),
		)
		.slice(-12)
		.map((message) => ({
			role: message.role,
			content: message.content,
			containsUntrustedAgentContent: message.containsUntrustedAgentContent,
		}));
}

function buildSubagentContext(
	identity: AgentIdentity,
	parentState: AgentState,
): string {
	return [
		`You are a ${identity.type} sub-agent working for a parent coding agent.`,
		`Agent runtime identity: ${JSON.stringify({ agentId: identity.id, parentId: identity.parentId })}`,
		"Complete only the delegated task, use the available tools autonomously, and return a concise evidence-backed result.",
		"Do not ask the user questions and do not attempt to spawn another sub-agent.",
		"Raw parent tool outputs are intentionally not included.",
		`Parent runtime context: ${JSON.stringify({
			plan: parentState.plan,
			todos: parentState.todos,
			changedFiles: parentState.changedFiles,
		})}`,
	].join("\n");
}
