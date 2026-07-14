import { randomUUID } from "node:crypto";
import type { ToolSpec } from "./tools/types";

export type Role = "user" | "assistant" | "tool" | "system";

export type Message = {
	role: Role;
	content: string;
	/** Present on assistant messages that request tool calls. */
	toolCalls?: { id: string; name: string; arguments: string }[];
	/** Present on role:'tool' messages, linking back to the requesting call. */
	toolCallId?: string;
};

export type TodoItem = {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "done" | "failed";
};

export type Observation = {
	tool: string;
	args: Record<string, unknown>;
	ok: boolean;
	output: string;
	exitCode?: number;
};

export type ToolCall = {
	name: string;
	args: Record<string, unknown>;
};

export type BudgetState = {
	turnsUsed: number;
	maxTurns: number;
};

export type CompactionState = {
	/** Consecutive automatic compaction failures in this session. */
	consecutiveFailures: number;
};

export type AgentMode = "normal" | "plan";
export type AgentType = "main" | "memory";

export type PlanItemStatus = "pending" | "in_progress" | "completed";

export type PlanItem = {
	step: string;
	status: PlanItemStatus;
};

export type RuntimePlan = {
	explanation?: string;
	items: PlanItem[];
};

export type PendingPlanApproval = {
	plan: string;
	runtimePlan: RuntimePlan;
};

export type ToolPermissionContext = {
	mode: AgentMode;
	agentType: AgentType;
	writePolicy?: {
		allow?: string[];
		deny?: string[];
	};
	prePlanMode?: AgentMode;
	pendingPlanApproval?: PendingPlanApproval;
};

export type TransitionReason =
	| "start"
	| "next_turn"
	| "tool_error"
	| "max_turns"
	| "complete"
	| "plan_approval"
	| "plan_approved"
	| "plan_rejected"
	| "permission_denied";

export type AgentState = {
	sessionId: string;
	task: string;
	cwd: string;
	toolSpecs: ToolSpec[];
	toolPermissionContext: ToolPermissionContext;
	plan: RuntimePlan;
	messages: Message[];
	todos: TodoItem[];
	observations: Observation[];
	changedFiles: string[];
	turn: number;
	maxTurns: number;
	budget: BudgetState;
	compaction: CompactionState;
	lastToolCall?: ToolCall;
	finalAnswer?: string;
	transition?: {
		reason: TransitionReason;
	};
};

export function createSessionId(): string {
	return randomUUID();
}

export function createInitialState(
	task: string,
	cwd: string,
	tools: ToolSpec[] = [],
	sessionId = createSessionId(),
): AgentState {
	return {
		sessionId,
		task,
		cwd,
		toolSpecs: tools,
		toolPermissionContext: createToolPermissionContext(),
		plan: createEmptyPlan(),
		messages: [{ role: "user", content: task }],
		todos: [],
		observations: [],
		changedFiles: [],
		turn: 0,
		maxTurns: 20,
		budget: {
			turnsUsed: 0,
			maxTurns: 20,
		},
		compaction: { consecutiveFailures: 0 },
		transition: { reason: "start" },
	};
}

export function continueState(prev: AgentState, task: string): AgentState {
	return {
		...ensureToolPermissionContext(prev),
		task,
		messages: [...prev.messages, { role: "user", content: task }],
	};
}

export function createToolPermissionContext(
	_cwd?: string,
	options: {
		mode?: AgentMode;
		agentType?: AgentType;
		writePolicy?: ToolPermissionContext["writePolicy"];
	} = {},
): ToolPermissionContext {
	return {
		mode: options.mode ?? "normal",
		agentType: options.agentType ?? "main",
		writePolicy: options.writePolicy,
	};
}

export function ensureToolPermissionContext(state: AgentState): AgentState {
	return {
		...state,
		toolPermissionContext: normalizeToolPermissionContext(
			state.toolPermissionContext,
			state.cwd,
		),
		plan: state.plan ?? createEmptyPlan(),
	};
}

export function enterPlanMode(prev: AgentState): AgentState {
	const state = ensureToolPermissionContext(prev);
	const current = state.toolPermissionContext;

	if (current.mode === "plan") {
		return {
			...state,
			toolPermissionContext: {
				...current,
				pendingPlanApproval: undefined,
			},
		};
	}

	return {
		...state,
		plan: createEmptyPlan(),
		toolPermissionContext: {
			...current,
			mode: "plan",
			prePlanMode: current.mode,
			pendingPlanApproval: undefined,
		},
	};
}

export function requestPlanApproval(
	prev: AgentState,
	plan: string,
	runtimePlan: RuntimePlan,
): AgentState {
	const state = ensureToolPermissionContext(prev);

	return {
		...state,
		toolPermissionContext: {
			...state.toolPermissionContext,
			pendingPlanApproval: { plan, runtimePlan },
		},
		transition: { reason: "plan_approval" },
	};
}

export function updateRuntimePlan(
	prev: AgentState,
	plan: RuntimePlan,
): AgentState {
	const state = ensureToolPermissionContext(prev);
	return {
		...state,
		plan,
	};
}

export function resolvePlanApproval(
	prev: AgentState,
	decision: "approve" | "reject",
	feedback = "",
): AgentState {
	const state = ensureToolPermissionContext(prev);
	const pending = state.toolPermissionContext.pendingPlanApproval;
	if (!pending) {
		return state;
	}

	if (decision === "approve") {
		const restoreMode = state.toolPermissionContext.prePlanMode ?? "normal";
		return {
			...state,
			task: "Implement the approved plan",
			toolPermissionContext: {
				...state.toolPermissionContext,
				mode: restoreMode,
				prePlanMode: undefined,
				pendingPlanApproval: undefined,
			},
			messages: [
				...state.messages,
				{
					role: "user",
					content: `User approved the plan. You can now implement it.\n\nApproved plan:\n\n${pending.plan}`,
				},
			],
			transition: { reason: "plan_approved" },
		};
	}

	const feedbackText = feedback.trim()
		? `\n\nUser feedback: ${feedback.trim()}`
		: "";
	return {
		...state,
		task: "Revise the plan",
		toolPermissionContext: {
			...state.toolPermissionContext,
			mode: "plan",
			pendingPlanApproval: undefined,
		},
		messages: [
			...state.messages,
			{
				role: "user",
				content: `User rejected the plan. Stay in plan mode, revise the runtime plan, and call ExitPlanMode again when ready.${feedbackText}`,
			},
		],
		transition: { reason: "plan_rejected" },
	};
}

function createEmptyPlan(): RuntimePlan {
	return { items: [] };
}

export function normalizeToolPermissionContext(
	context: Partial<ToolPermissionContext> | undefined,
	cwd?: string,
): ToolPermissionContext {
	const defaults = createToolPermissionContext(cwd);
	return {
		...defaults,
		...context,
		mode: context?.mode ?? defaults.mode,
		agentType: context?.agentType ?? defaults.agentType,
	};
}
