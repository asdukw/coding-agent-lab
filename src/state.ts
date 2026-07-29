import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentIdentity } from "./agents/identity";
import {
	createEmptyTaskGraph,
	normalizeTaskGraph,
	type TaskGraphState,
} from "./tasks";
import type { ToolExecution } from "./toolExecutionMemory";
import type { ToolSpec } from "./tools/types";

export type Role = "user" | "assistant" | "tool" | "system" | "agent";

export type ToolFailureKind =
	| "permission_denied"
	| "backend_unavailable"
	| "command_failed"
	| "runtime_error";

export type ToolFailure = {
	kind: ToolFailureKind;
	message: string;
	stage?: string;
	exitCode?: number;
};

export type ToolResultMetadata =
	| { status: "succeeded"; failure?: never }
	| { status: "failed"; failure: ToolFailure };

export type Message = {
	role: Role;
	content: string;
	/** Marks a local approval response so the UI does not present it as user input. */
	origin?: "approval";
	/** Present on assistant messages that request tool calls. */
	toolCalls?: { id: string; name: string; arguments: string }[];
	/** Present on role:'tool' messages, linking back to the requesting call. */
	toolCallId?: string;
	/** Structured execution status; content remains the model-facing tool result. */
	toolResult?: ToolResultMetadata;
	/** Preserves the trust boundary when a system compaction summarizes agent data. */
	containsUntrustedAgentContent?: boolean;
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
	failure?: ToolFailure;
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
export type AgentType = "main" | "memory" | "subagent";
export type ApprovalMode = "ask" | "auto" | "full_access";
export type ApprovalPolicy = "always_ask" | "ask_on_risk" | "never";
export type SandboxPolicy = "workspace_write" | "danger_full_access";

export type PermissionPolicy = {
	approval: ApprovalPolicy;
	sandbox: SandboxPolicy;
};

const PERMISSION_POLICIES: Record<ApprovalMode, PermissionPolicy> = {
	ask: { approval: "always_ask", sandbox: "workspace_write" },
	auto: { approval: "ask_on_risk", sandbox: "workspace_write" },
	full_access: { approval: "never", sandbox: "danger_full_access" },
};

export function permissionPolicyForMode(mode: ApprovalMode): PermissionPolicy {
	return PERMISSION_POLICIES[mode];
}

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

export type PendingToolCall = {
	id: string;
	name: string;
	arguments: string;
};

export type ToolApprovalRequest = {
	callId: string;
	toolName: string;
	args: Record<string, unknown>;
	argumentFingerprint: string;
	reason: string;
};

export type ToolApprovalDecision = "allow_once" | "allow_session" | "deny";

export type PendingToolApproval = {
	calls: PendingToolCall[];
	requests: ToolApprovalRequest[];
	decision?: ToolApprovalDecision;
	decisionId?: string;
	needsRevalidation?: boolean;
};

const consumedToolApprovalDecisionIds = new Set<string>();

export type ToolPermissionContext = {
	mode: AgentMode;
	agentType: AgentType;
	approvalMode: ApprovalMode;
	writePolicy?: {
		allow?: string[];
		deny?: string[];
	};
	/** Tool names approved for the lifetime of the current process session. */
	sessionAllowedTools: string[];
	prePlanMode?: AgentMode;
	pendingPlanApproval?: PendingPlanApproval;
	pendingToolApproval?: PendingToolApproval;
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
	| "permission_approval"
	| "permission_approved"
	| "permission_denied";

export type AgentState = {
	agent: AgentIdentity;
	sessionId: string;
	task: string;
	cwd: string;
	toolSpecs: ToolSpec[];
	toolPermissionContext: ToolPermissionContext;
	plan: RuntimePlan;
	taskGraph: TaskGraphState;
	messages: Message[];
	todos: TodoItem[];
	observations: Observation[];
	toolExecutions: ToolExecution[];
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

export function hasDangerFullAccess(state: AgentState): boolean {
	return (
		state.toolPermissionContext.agentType === "main" &&
		permissionPolicyForMode(state.toolPermissionContext.approvalMode)
			.sandbox === "danger_full_access"
	);
}

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
		agent: {
			id: sessionId,
			type: "main",
			depth: 0,
		},
		sessionId,
		task,
		cwd,
		toolSpecs: tools,
		toolPermissionContext: createToolPermissionContext(cwd),
		plan: createEmptyPlan(),
		taskGraph: createEmptyTaskGraph(),
		messages: [{ role: "user", content: task }],
		todos: [],
		observations: [],
		toolExecutions: [],
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
		budget: { ...prev.budget, turnsUsed: 0 },
	};
}

export function createToolPermissionContext(
	_cwd?: string,
	options: {
		mode?: AgentMode;
		agentType?: AgentType;
		approvalMode?: ApprovalMode;
		writePolicy?: ToolPermissionContext["writePolicy"];
		sessionAllowedTools?: string[];
	} = {},
): ToolPermissionContext {
	return {
		mode: options.mode ?? "normal",
		agentType: options.agentType ?? "main",
		approvalMode: options.approvalMode ?? "ask",
		writePolicy: options.writePolicy ?? defaultWritePolicy(_cwd),
		sessionAllowedTools: uniqueStrings(options.sessionAllowedTools ?? []),
	};
}

export function setApprovalMode(
	prev: AgentState,
	approvalMode: ApprovalMode,
): AgentState {
	const state = ensureToolPermissionContext(prev);
	if (state.toolPermissionContext.approvalMode === approvalMode) {
		return state;
	}
	return {
		...state,
		toolPermissionContext: {
			...state.toolPermissionContext,
			approvalMode,
			// A policy switch invalidates grants and decisions made under the old mode.
			sessionAllowedTools: [],
			pendingToolApproval: undefined,
		},
	};
}

export function ensureToolPermissionContext(state: AgentState): AgentState {
	return {
		...state,
		agent: state.agent ?? {
			id: state.sessionId,
			type:
				state.toolPermissionContext?.agentType === "memory" ? "memory" : "main",
			depth: state.toolPermissionContext?.agentType === "memory" ? 1 : 0,
		},
		toolPermissionContext: normalizeToolPermissionContext(
			state.toolPermissionContext,
			state.cwd,
		),
		plan: state.plan ?? createEmptyPlan(),
		taskGraph: normalizeTaskGraph(state.taskGraph),
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
					origin: "approval",
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
				origin: "approval",
			},
		],
		transition: { reason: "plan_rejected" },
	};
}

export function requestToolApproval(
	prev: AgentState,
	calls: readonly PendingToolCall[],
	requests: readonly ToolApprovalRequest[],
): AgentState {
	const state = ensureToolPermissionContext(prev);
	if (requests.length === 0) {
		return state;
	}
	return {
		...state,
		toolPermissionContext: {
			...state.toolPermissionContext,
			pendingToolApproval: {
				calls: calls.map((call) => ({ ...call })),
				requests: requests.map((request) => ({
					...request,
					args: { ...request.args },
				})),
			},
		},
		transition: { reason: "permission_approval" },
	};
}

export function resolveToolApproval(
	prev: AgentState,
	decision: ToolApprovalDecision,
): AgentState {
	const state = ensureToolPermissionContext(prev);
	const pending = state.toolPermissionContext.pendingToolApproval;
	if (!pending) {
		return state;
	}
	return {
		...state,
		toolPermissionContext: {
			...state.toolPermissionContext,
			pendingToolApproval: {
				...pending,
				decision,
				decisionId: randomUUID(),
			},
		},
		transition: {
			reason: decision === "deny" ? "permission_denied" : "permission_approved",
		},
	};
}

export function replaceToolApprovalRequests(
	prev: AgentState,
	requests: readonly ToolApprovalRequest[],
): AgentState {
	const state = ensureToolPermissionContext(prev);
	const pending = state.toolPermissionContext.pendingToolApproval;
	if (!pending) {
		return state;
	}
	return {
		...state,
		toolPermissionContext: {
			...state.toolPermissionContext,
			pendingToolApproval: {
				calls: pending.calls.map((call) => ({ ...call })),
				requests: requests.map((request) => ({
					...request,
					args: { ...request.args },
				})),
				needsRevalidation: false,
			},
		},
	};
}

export function claimToolApprovalDecision(state: AgentState): boolean {
	const pending = state.toolPermissionContext.pendingToolApproval;
	if (!pending?.decision || !pending.decisionId) {
		return false;
	}
	if (consumedToolApprovalDecisionIds.has(pending.decisionId)) {
		return false;
	}
	consumedToolApprovalDecisionIds.add(pending.decisionId);
	return true;
}

export function clearToolApproval(prev: AgentState): AgentState {
	const state = ensureToolPermissionContext(prev);
	const pending = state.toolPermissionContext.pendingToolApproval;
	if (!pending) {
		return state;
	}
	const sessionAllowedTools =
		pending.decision === "allow_session" && !pending.needsRevalidation
			? uniqueStrings([
					...state.toolPermissionContext.sessionAllowedTools,
					...approvedPendingToolNames(pending),
				])
			: state.toolPermissionContext.sessionAllowedTools;
	return {
		...state,
		toolPermissionContext: {
			...state.toolPermissionContext,
			sessionAllowedTools,
			pendingToolApproval: undefined,
		},
	};
}

function approvedPendingToolNames(pending: PendingToolApproval): string[] {
	return pending.requests
		.filter(
			(request) =>
				request.argumentFingerprint ===
					approvalArgumentFingerprint(request.args) &&
				pending.calls.some(
					(call) =>
						call.id === request.callId && call.name === request.toolName,
				),
		)
		.map((request) => request.toolName);
}

export function completedPendingToolCallIds(
	messages: readonly Message[],
	calls: readonly PendingToolCall[],
): Set<string> {
	let batchMessageIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (
			message?.role === "assistant" &&
			toolCallBatchesEqual(message.toolCalls, calls)
		) {
			batchMessageIndex = index;
			break;
		}
	}
	if (batchMessageIndex < 0) {
		return new Set();
	}

	const pendingIds = new Set(calls.map((call) => call.id));
	return new Set(
		messages
			.slice(batchMessageIndex + 1)
			.filter(
				(message) =>
					message.role === "tool" &&
					message.toolCallId !== undefined &&
					pendingIds.has(message.toolCallId),
			)
			.map((message) => message.toolCallId as string),
	);
}

function toolCallBatchesEqual(
	left: readonly PendingToolCall[] | undefined,
	right: readonly PendingToolCall[],
): boolean {
	return (
		left?.length === right.length &&
		left.every(
			(call, index) =>
				call.id === right[index]?.id &&
				call.name === right[index]?.name &&
				call.arguments === right[index]?.arguments,
		)
	);
}

function createEmptyPlan(): RuntimePlan {
	return { items: [] };
}

export function normalizeToolPermissionContext(
	context: Partial<ToolPermissionContext> | undefined,
	cwd?: string,
): ToolPermissionContext {
	const defaults = createToolPermissionContext(cwd);
	const mode = context?.mode === "plan" ? "plan" : "normal";
	const agentType =
		context?.agentType === "subagent" || context?.agentType === "memory"
			? context.agentType
			: "main";
	const approvalMode =
		context?.approvalMode === "auto" || context?.approvalMode === "full_access"
			? context.approvalMode
			: "ask";
	return {
		...defaults,
		...context,
		mode,
		agentType,
		approvalMode,
		writePolicy: normalizeWritePolicy(
			context?.writePolicy,
			defaults.writePolicy,
		),
		sessionAllowedTools: uniqueStrings(context?.sessionAllowedTools),
		prePlanMode:
			context?.prePlanMode === "normal" || context?.prePlanMode === "plan"
				? context.prePlanMode
				: undefined,
	};
}

function defaultWritePolicy(
	cwd: string | undefined,
): ToolPermissionContext["writePolicy"] {
	if (!cwd) {
		return undefined;
	}
	const workspaceRoot = resolve(cwd);
	return {
		allow: [workspaceRoot],
		deny: [
			resolve(workspaceRoot, ".git"),
			resolve(workspaceRoot, ".env"),
			resolve(workspaceRoot, ".cagent-sandbox"),
		],
	};
}

function normalizeWritePolicy(
	value: unknown,
	fallback: ToolPermissionContext["writePolicy"],
): ToolPermissionContext["writePolicy"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return fallback;
	}
	const candidate = value as Record<string, unknown>;
	const hasAllow = Array.isArray(candidate.allow);
	const hasDeny = Array.isArray(candidate.deny);
	if (!hasAllow && !hasDeny) {
		return fallback;
	}
	return {
		allow: hasAllow ? uniqueStrings(candidate.allow) : undefined,
		deny: hasDeny ? uniqueStrings(candidate.deny) : undefined,
	};
}

function uniqueStrings(values: unknown): string[] {
	if (!Array.isArray(values)) {
		return [];
	}
	return [
		...new Set(
			values
				.filter(
					(value): value is string =>
						typeof value === "string" && value.trim().length > 0,
				)
				.map((value) => value.trim()),
		),
	];
}

function approvalArgumentFingerprint(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(approvalArgumentFingerprint).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([key, entry]) =>
					`${JSON.stringify(key)}:${approvalArgumentFingerprint(entry)}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}
