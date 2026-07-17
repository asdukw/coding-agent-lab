import { randomUUID } from "node:crypto";
import {
	access,
	appendFile,
	mkdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { resolveContainedWritePath } from "./pathSafety";
import {
	type AgentState,
	type BudgetState,
	type CompactionState,
	completedPendingToolCallIds,
	type Message,
	normalizeToolPermissionContext,
	type PendingToolApproval,
	type RuntimePlan,
	type ToolPermissionContext,
} from "./state";
import {
	deriveToolExecutions,
	parseToolArguments,
	recordToolCall,
	recordToolResult,
	type ToolExecution,
} from "./toolExecutionMemory";
import { BUILTIN_TOOLS } from "./tools";
import { toToolSpecs } from "./tools/types";

const SESSION_DIR = ".cagent/sessions";
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SESSION_INDEX_FILE = "session_index.jsonl";
const MEMORY_EXTRACTION_AUDIT_DIR = ".cagent/audit/memory-extraction";

export type SessionMemoryExtractionResult = {
	subAgentSessionId: string;
	ok: boolean;
	summary: string;
	reason?: string;
	reasons?: string[];
};

export type StoredSessionState = {
	sessionId: string;
	task: string;
	cwd: string;
	toolPermissionContext?: ToolPermissionContext;
	plan?: RuntimePlan;
	messages: Message[];
	toolExecutions?: ToolExecution[];
	changedFiles?: string[];
	turn: number;
	budget: BudgetState;
	compaction?: CompactionState;
};

export type StoredSession = {
	version: 1;
	id: string;
	savedAt: string;
	state: StoredSessionState;
};

export type SessionEvent =
	| {
			version: 2;
			timestamp: string;
			type: "session_meta";
			sessionId: string;
			payload: {
				cwd: string;
				task: string;
			};
	  }
	| {
			version: 2;
			timestamp: string;
			type: "context_compaction";
			sessionId: string;
			payload: {
				messages: Message[];
				compaction: CompactionState;
			};
	  }
	| {
			version: 2;
			timestamp: string;
			type:
				| "user_message"
				| "agent_message"
				| "assistant_message"
				| "tool_result";
			sessionId: string;
			payload: {
				message: Message;
			};
	  }
	| {
			version: 2;
			timestamp: string;
			type: "tool_call";
			sessionId: string;
			payload: {
				id: string;
				name: string;
				arguments: string;
			};
	  }
	| {
			version: 2;
			timestamp: string;
			type: "state_snapshot";
			sessionId: string;
			payload: {
				task: string;
				toolPermissionContext: ToolPermissionContext;
				plan: RuntimePlan;
				turn: number;
				budget: BudgetState;
				compaction: CompactionState;
				toolExecutions?: ToolExecution[];
				changedFiles?: string[];
			};
	  }
	| {
			version: 2;
			timestamp: string;
			type: "memory_extraction";
			sessionId: string;
			payload: {
				subAgentSessionId: string;
				ok: boolean;
				summary: string;
				reason?: string;
				reasons?: string[];
			};
	  };

type LegacySessionEvent =
	| {
			type: "session_start";
			version: 1;
			sessionId: string;
			cwd: string;
			task: string;
			createdAt: string;
	  }
	| {
			type: "message";
			sessionId: string;
			message: Message;
			createdAt: string;
	  }
	| {
			type: "state";
			sessionId: string;
			task: string;
			toolPermissionContext: ToolPermissionContext;
			plan: RuntimePlan;
			turn: number;
			budget: BudgetState;
			savedAt: string;
	  }
	| {
			type: "memory_extraction";
			sessionId: string;
			subAgentSessionId: string;
			ok: boolean;
			summary: string;
			createdAt: string;
	  };

export type SessionIndexEntry = {
	version: 1;
	sessionId: string;
	cwd: string;
	task: string;
	path: string;
	updatedAt: string;
};

export function getSessionPath(cwd: string, sessionId: string): string {
	return getSessionFilePath(cwd, sessionId, "jsonl");
}

export function getSessionIndexPath(cwd: string): string {
	return resolve(cwd, SESSION_DIR, SESSION_INDEX_FILE);
}

export async function ensureSessionStarted(
	cwd: string,
	state: AgentState,
): Promise<string> {
	const path = getSessionPath(cwd, state.sessionId);
	if (await pathExists(path)) {
		return path;
	}

	await appendSessionEvent(cwd, {
		version: 2,
		timestamp: new Date().toISOString(),
		type: "session_meta",
		sessionId: state.sessionId,
		payload: {
			cwd: state.cwd,
			task: state.task,
		},
	});
	await appendSessionIndex(cwd, state);
	return path;
}

export async function appendSessionMessage(
	cwd: string,
	state: AgentState,
	message: Message,
): Promise<void> {
	await ensureSessionStarted(cwd, state);
	for (const event of createMessageEvents(state.sessionId, message)) {
		await appendSessionEvent(cwd, event);
	}
}

export async function appendSessionState(
	cwd: string,
	state: AgentState,
): Promise<void> {
	await ensureSessionStarted(cwd, state);
	await appendSessionEvent(cwd, {
		version: 2,
		timestamp: new Date().toISOString(),
		type: "state_snapshot",
		sessionId: state.sessionId,
		payload: {
			task: state.task,
			toolPermissionContext: persistableToolPermissionContext(
				state.toolPermissionContext,
			),
			plan: state.plan,
			turn: state.turn,
			budget: state.budget,
			compaction: state.compaction,
			toolExecutions: state.toolExecutions,
			changedFiles: state.changedFiles,
		},
	});
	await appendSessionIndex(cwd, state);
}

export async function appendSessionCompaction(
	cwd: string,
	state: AgentState,
): Promise<void> {
	await ensureSessionStarted(cwd, state);
	await appendSessionEvent(cwd, {
		version: 2,
		timestamp: new Date().toISOString(),
		type: "context_compaction",
		sessionId: state.sessionId,
		payload: {
			messages: state.messages,
			compaction: state.compaction,
		},
	});
	await appendSessionIndex(cwd, state);
}

export async function appendSessionMemoryExtraction(
	cwd: string,
	state: AgentState,
	result: SessionMemoryExtractionResult,
): Promise<void> {
	await ensureSessionStarted(cwd, state);
	await appendSessionEvent(cwd, {
		version: 2,
		timestamp: new Date().toISOString(),
		type: "memory_extraction",
		sessionId: state.sessionId,
		payload: {
			subAgentSessionId: result.subAgentSessionId,
			ok: result.ok,
			summary: result.summary,
			reason: result.reason,
			reasons: result.reasons,
		},
	});
}

export async function persistSessionMemoryExtraction(
	cwd: string,
	state: AgentState,
	result: SessionMemoryExtractionResult,
): Promise<void> {
	try {
		await appendSessionMemoryExtraction(cwd, state, result);
	} catch (primaryError) {
		const fallbackDir = getMemoryExtractionAuditDir(cwd);
		const fallbackPath = resolve(
			fallbackDir,
			`${Date.now()}-${randomUUID()}.json`,
		);
		try {
			await resolveContainedWritePath({
				targetPath: fallbackDir,
				directoryPath: fallbackDir,
				boundaryPath: cwd,
			});
			await mkdir(fallbackDir, { recursive: true });
			await resolveContainedWritePath({
				targetPath: fallbackPath,
				directoryPath: fallbackDir,
				boundaryPath: cwd,
			});
			await writeFile(
				fallbackPath,
				JSON.stringify({
					timestamp: new Date().toISOString(),
					type: "memory_extraction_persistence_fallback",
					sessionId: state.sessionId,
					payload: result,
					persistenceError: formatCaught(primaryError),
				}),
				{ encoding: "utf8", flag: "wx" },
			);
		} catch (fallbackError) {
			throw new AggregateError(
				[primaryError, fallbackError],
				"memory extraction audit persistence failed",
			);
		}
	}
}

export function getMemoryExtractionAuditDir(cwd: string): string {
	return resolve(cwd, MEMORY_EXTRACTION_AUDIT_DIR);
}

export async function saveSession(
	cwd: string,
	state: AgentState,
): Promise<string> {
	const path = getSessionPath(cwd, state.sessionId);
	const toolExecutions = state.toolExecutions.length
		? state.toolExecutions
		: deriveToolExecutions(state.messages);
	const events: SessionEvent[] = [
		{
			version: 2,
			timestamp: new Date().toISOString(),
			type: "session_meta",
			sessionId: state.sessionId,
			payload: {
				cwd: state.cwd,
				task: state.task,
			},
		},
		...state.messages.flatMap((message) =>
			createMessageEvents(state.sessionId, message),
		),
		{
			version: 2,
			timestamp: new Date().toISOString(),
			type: "state_snapshot",
			sessionId: state.sessionId,
			payload: {
				task: state.task,
				toolPermissionContext: persistableToolPermissionContext(
					state.toolPermissionContext,
				),
				plan: state.plan,
				turn: state.turn,
				budget: state.budget,
				compaction: state.compaction,
				toolExecutions,
				changedFiles: state.changedFiles,
			},
		},
	];

	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		`${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
		"utf8",
	);
	await appendSessionIndex(cwd, state);
	return path;
}

export async function loadSession(
	cwd: string,
	sessionId: string,
): Promise<AgentState> {
	const path = getSessionPath(cwd, sessionId);
	try {
		const raw = await readFile(path, "utf8");
		return fromStoredSessionState(
			replaySessionEvents(raw, sessionId, cwd),
			cwd,
		);
	} catch (caught) {
		if (!isNotFoundError(caught)) {
			throw caught;
		}
	}

	return loadLegacySession(cwd, sessionId);
}

async function appendSessionEvent(
	cwd: string,
	event: SessionEvent,
): Promise<void> {
	const path = getSessionPath(cwd, event.sessionId);
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

async function appendSessionIndex(
	cwd: string,
	state: AgentState,
): Promise<void> {
	const indexPath = getSessionIndexPath(cwd);
	const sessionPath = getSessionPath(cwd, state.sessionId);
	const entry: SessionIndexEntry = {
		version: 1,
		sessionId: state.sessionId,
		cwd: state.cwd,
		task: state.task,
		path: relative(resolve(cwd), sessionPath),
		updatedAt: new Date().toISOString(),
	};

	await mkdir(dirname(indexPath), { recursive: true });
	await appendFile(indexPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function replaySessionEvents(
	raw: string,
	sessionId: string,
	fallbackCwd: string,
): StoredSessionState {
	let state: StoredSessionState = {
		sessionId,
		task: "",
		cwd: fallbackCwd,
		messages: [],
		toolExecutions: [],
		changedFiles: [],
		turn: 0,
		budget: { turnsUsed: 0, maxTurns: 20 },
	};

	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) {
			continue;
		}

		const event = JSON.parse(line) as SessionEvent | LegacySessionEvent;
		if (event.sessionId !== sessionId) {
			throw new Error(`session id mismatch in event: ${sessionId}`);
		}

		if (isCurrentSessionEvent(event)) {
			state = applyCurrentSessionEvent(state, event);
		} else if (event.type === "session_start") {
			state = {
				...state,
				sessionId: event.sessionId,
				task: event.task,
				cwd: event.cwd,
			};
		} else if (event.type === "message") {
			state = {
				...state,
				messages: [...state.messages, event.message],
			};
		} else if (event.type === "state") {
			state = {
				...state,
				task: event.task,
				toolPermissionContext: event.toolPermissionContext,
				plan: event.plan,
				turn: event.turn,
				budget: event.budget,
			};
		}
	}

	return state;
}

function createMessageEvents(
	sessionId: string,
	message: Message,
): SessionEvent[] {
	const timestamp = new Date().toISOString();
	const type = messageEventType(message);
	const events: SessionEvent[] = [
		{
			version: 2,
			timestamp,
			type,
			sessionId,
			payload: { message },
		},
	];

	if (message.role === "assistant" && message.toolCalls) {
		for (const call of message.toolCalls) {
			events.push({
				version: 2,
				timestamp,
				type: "tool_call",
				sessionId,
				payload: {
					id: call.id,
					name: call.name,
					arguments: call.arguments,
				},
			});
		}
	}

	return events;
}

function messageEventType(
	message: Message,
): "user_message" | "agent_message" | "assistant_message" | "tool_result" {
	if (message.role === "user") {
		return "user_message";
	}
	if (message.role === "agent") {
		return "agent_message";
	}
	if (message.role === "tool") {
		return "tool_result";
	}
	return "assistant_message";
}

function isCurrentSessionEvent(
	event: SessionEvent | LegacySessionEvent,
): event is SessionEvent {
	return "version" in event && event.version === 2;
}

function applyCurrentSessionEvent(
	state: StoredSessionState,
	event: SessionEvent,
): StoredSessionState {
	if (event.type === "session_meta") {
		return {
			...state,
			sessionId: event.sessionId,
			task: event.payload.task,
			cwd: event.payload.cwd,
		};
	}

	if (
		event.type === "user_message" ||
		event.type === "agent_message" ||
		event.type === "assistant_message"
	) {
		return {
			...state,
			messages: [...state.messages, event.payload.message],
		};
	}

	if (event.type === "tool_call") {
		return {
			...state,
			toolExecutions: recordToolCall(state.toolExecutions ?? [], {
				callId: event.payload.id,
				tool: event.payload.name,
				args: parseToolArguments(event.payload.arguments),
				timestamp: event.timestamp,
			}),
		};
	}

	if (event.type === "tool_result") {
		const message = event.payload.message;
		return {
			...state,
			messages: [...state.messages, message],
			toolExecutions: message.toolCallId
				? recordToolResult(
						state.toolExecutions ?? [],
						message.toolCallId,
						!message.content.startsWith("error:"),
					)
				: state.toolExecutions,
		};
	}

	if (event.type === "state_snapshot") {
		return {
			...state,
			task: event.payload.task,
			toolPermissionContext: event.payload.toolPermissionContext,
			plan: event.payload.plan,
			turn: event.payload.turn,
			budget: event.payload.budget,
			compaction: event.payload.compaction,
			toolExecutions: event.payload.toolExecutions ?? state.toolExecutions,
			changedFiles: event.payload.changedFiles ?? state.changedFiles,
		};
	}

	if (event.type === "context_compaction") {
		return {
			...state,
			messages: event.payload.messages,
			compaction: event.payload.compaction,
		};
	}

	return state;
}

async function loadLegacySession(
	cwd: string,
	sessionId: string,
): Promise<AgentState> {
	const path = getSessionFilePath(cwd, sessionId, "json");
	const raw = await readFile(path, "utf8");
	const parsed = JSON.parse(raw) as Partial<StoredSession>;

	if (parsed.version !== 1 || parsed.id !== sessionId || !parsed.state) {
		throw new Error(`invalid session file: ${path}`);
	}

	const storedState = parsed.state as Partial<StoredSessionState>;
	if (storedState.sessionId !== sessionId) {
		throw new Error(`session id mismatch in file: ${path}`);
	}

	return fromStoredSessionState(storedState, cwd);
}

function getSessionFilePath(
	cwd: string,
	sessionId: string,
	extension: "json" | "jsonl",
): string {
	if (
		!SESSION_ID_PATTERN.test(sessionId) ||
		sessionId === "." ||
		sessionId === ".."
	) {
		throw new Error(`invalid session id: ${sessionId}`);
	}

	const sessionsDir = resolve(cwd, SESSION_DIR);
	const sessionPath = resolve(sessionsDir, `${sessionId}.${extension}`);

	if (
		!sessionPath.startsWith(`${sessionsDir}${sep}`) &&
		sessionPath !== sessionsDir
	) {
		throw new Error(`invalid session path for id: ${sessionId}`);
	}

	return sessionPath;
}

function fromStoredSessionState(
	state: Partial<StoredSessionState>,
	trustedCwd?: string,
): AgentState {
	const budget = normalizeRestoredBudget(state.budget);
	// Session files are workspace-writable. The caller-provided root is the trust
	// boundary; a stored cwd must never expand it during resume.
	const cwd = resolve(trustedCwd ?? state.cwd ?? process.cwd());
	const messages = validateRestoredMessages(state.messages);
	return {
		agent: {
			id: state.sessionId ?? "",
			type: "main",
			depth: 0,
		},
		sessionId: state.sessionId ?? "",
		task: typeof state.task === "string" ? state.task : "",
		cwd,
		toolSpecs: toToolSpecs(BUILTIN_TOOLS),
		toolPermissionContext: normalizeToolPermissionContext(
			restoredPermissionContext(state.toolPermissionContext, messages),
			cwd,
		),
		plan: normalizeRestoredPlan(state.plan),
		messages,
		todos: [],
		observations: [],
		// Rebuild bounded execution memory from validated messages instead of
		// trusting a writable snapshot to inject system-level history.
		toolExecutions: deriveToolExecutions(messages),
		changedFiles: Array.isArray(state.changedFiles)
			? state.changedFiles.filter(
					(path): path is string => typeof path === "string",
				)
			: [],
		turn: boundedNonNegativeInteger(state.turn, budget.turnsUsed, 1_000_000),
		maxTurns: budget.maxTurns,
		budget,
		compaction: {
			consecutiveFailures: boundedNonNegativeInteger(
				state.compaction?.consecutiveFailures,
				0,
				3,
			),
		},
		transition: { reason: "start" },
	};
}

function restoredPermissionContext(
	context: ToolPermissionContext | undefined,
	messages: readonly Message[],
): ToolPermissionContext | undefined {
	if (!isRecord(context)) {
		return undefined;
	}
	const pending = validateRestoredPendingToolApproval(
		context.pendingToolApproval,
	);
	if (pending && !hasRestoredToolBatch(messages, pending.calls)) {
		throw new Error("pending tool approval has no matching assistant batch");
	}
	const completedCallIds = pending
		? completedPendingToolCallIds(messages, pending.calls)
		: new Set<string>();
	const remainingCalls =
		pending?.calls.filter((call) => !completedCallIds.has(call.id)) ?? [];
	const remainingCallIds = new Set(remainingCalls.map((call) => call.id));
	const remainingRequests =
		pending?.requests.filter((request) =>
			remainingCallIds.has(request.callId),
		) ?? [];
	return {
		mode: context.mode === "plan" ? "plan" : "normal",
		agentType: "main",
		// The trusted caller cwd supplies a fresh workspace-bound default policy.
		writePolicy: undefined,
		// Session files live in the writable workspace and cannot grant approval.
		sessionAllowedTools: [],
		prePlanMode:
			context.prePlanMode === "normal" || context.prePlanMode === "plan"
				? context.prePlanMode
				: undefined,
		pendingPlanApproval: normalizeRestoredPendingPlanApproval(
			context.pendingPlanApproval,
		),
		pendingToolApproval:
			pending && remainingCalls.length > 0
				? {
						calls: remainingCalls.map((call) => ({ ...call })),
						requests: remainingRequests.map((request) => ({
							...request,
							args: { ...request.args },
						})),
						needsRevalidation: true,
					}
				: undefined,
	};
}

function persistableToolPermissionContext(
	context: ToolPermissionContext,
): ToolPermissionContext {
	const pending = context.pendingToolApproval;
	return {
		...context,
		// These grants are process-local and must not become durable authority.
		sessionAllowedTools: [],
		pendingToolApproval: pending
			? {
					calls: pending.calls.map((call) => ({ ...call })),
					requests: pending.requests.map((request) => ({
						...request,
						args: { ...request.args },
					})),
				}
			: undefined,
	};
}

function validateRestoredMessages(value: unknown): Message[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new Error("invalid session messages");
	}
	return value.map((entry, index) => {
		if (!isRecord(entry) || typeof entry.content !== "string") {
			throw new Error(`invalid session message at index ${index}`);
		}
		const untrusted = entry.containsUntrustedAgentContent === true;
		if (entry.role === "system") {
			return {
				role: "agent",
				content: `[restored-session:untrusted-system-message]\n${entry.content}`,
				containsUntrustedAgentContent: true,
			};
		}
		if (entry.role === "agent") {
			return {
				role: "agent",
				content: entry.content,
				containsUntrustedAgentContent: true,
			};
		}
		if (entry.role === "assistant") {
			const toolCalls = validateRestoredToolCalls(
				entry.toolCalls,
				`message ${index}`,
			);
			return {
				role: "assistant",
				content: entry.content,
				...(toolCalls === undefined ? {} : { toolCalls }),
				...(untrusted ? { containsUntrustedAgentContent: true } : {}),
			};
		}
		if (entry.role === "tool") {
			if (
				typeof entry.toolCallId !== "string" ||
				entry.toolCallId.trim().length === 0
			) {
				throw new Error(`invalid tool result at message ${index}`);
			}
			return {
				role: "tool",
				content: entry.content,
				toolCallId: entry.toolCallId,
				...(untrusted ? { containsUntrustedAgentContent: true } : {}),
			};
		}
		if (entry.role === "user") {
			return {
				role: "user",
				content: entry.content,
				...(untrusted ? { containsUntrustedAgentContent: true } : {}),
			};
		}
		throw new Error(`invalid session message role at index ${index}`);
	});
}

function validateRestoredToolCalls(
	value: unknown,
	label: string,
): Message["toolCalls"] {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new Error(`invalid tool calls in ${label}`);
	}
	const ids = new Set<string>();
	return value.map((entry, index) => {
		if (
			!isRecord(entry) ||
			typeof entry.id !== "string" ||
			entry.id.trim().length === 0 ||
			typeof entry.name !== "string" ||
			entry.name.trim().length === 0 ||
			typeof entry.arguments !== "string"
		) {
			throw new Error(`invalid tool call ${index} in ${label}`);
		}
		if (ids.has(entry.id)) {
			throw new Error(`duplicate tool call id in ${label}: ${entry.id}`);
		}
		ids.add(entry.id);
		return {
			id: entry.id,
			name: entry.name,
			arguments: entry.arguments,
		};
	});
}

function validateRestoredPendingToolApproval(
	value: unknown,
): PendingToolApproval | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (
		!isRecord(value) ||
		!Array.isArray(value.calls) ||
		!Array.isArray(value.requests)
	) {
		throw new Error("invalid pending tool approval in session");
	}
	const calls = validateRestoredToolCalls(value.calls, "pending tool approval");
	if (!calls || calls.length === 0) {
		throw new Error("pending tool approval has no calls");
	}
	const callsById = new Map(calls.map((call) => [call.id, call]));
	const requestIds = new Set<string>();
	const requests = value.requests.map((entry, index) => {
		if (
			!isRecord(entry) ||
			typeof entry.callId !== "string" ||
			entry.callId.trim().length === 0 ||
			typeof entry.toolName !== "string" ||
			entry.toolName.trim().length === 0 ||
			!isRecord(entry.args) ||
			typeof entry.argumentFingerprint !== "string" ||
			typeof entry.reason !== "string"
		) {
			throw new Error(`invalid pending tool request at index ${index}`);
		}
		const call = callsById.get(entry.callId);
		if (!call || call.name !== entry.toolName || requestIds.has(entry.callId)) {
			throw new Error(`unmatched pending tool request: ${entry.callId}`);
		}
		if (entry.argumentFingerprint !== stableStringify(entry.args)) {
			throw new Error(`invalid pending tool fingerprint: ${entry.callId}`);
		}
		requestIds.add(entry.callId);
		return {
			callId: entry.callId,
			toolName: entry.toolName,
			args: { ...entry.args },
			argumentFingerprint: entry.argumentFingerprint,
			reason: restoredToolApprovalReason(entry.toolName),
		};
	});
	return { calls, requests };
}

function restoredToolApprovalReason(toolName: string): string {
	if (toolName === "Shell") {
		return "executes a PowerShell command that can read host-user files, write in the workspace, and use inherited network access";
	}
	if (toolName.startsWith("mcp__")) {
		return "calls an external MCP tool whose side effects are not controlled by the workspace sandbox";
	}
	return `${toolName} modifies files in the workspace`;
}

function hasRestoredToolBatch(
	messages: readonly Message[],
	calls: NonNullable<Message["toolCalls"]>,
): boolean {
	return messages.some(
		(message) =>
			message.role === "assistant" &&
			message.toolCalls?.length === calls.length &&
			message.toolCalls.every(
				(call, index) =>
					call.id === calls[index]?.id &&
					call.name === calls[index]?.name &&
					call.arguments === calls[index]?.arguments,
			),
	);
}

function normalizeRestoredPendingPlanApproval(
	value: unknown,
): ToolPermissionContext["pendingPlanApproval"] {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value) || typeof value.plan !== "string") {
		throw new Error("invalid pending plan approval in session");
	}
	return {
		plan: value.plan,
		runtimePlan: normalizeRestoredPlan(value.runtimePlan),
	};
}

function normalizeRestoredPlan(value: unknown): RuntimePlan {
	if (value === undefined) {
		return { items: [] };
	}
	if (!isRecord(value) || !Array.isArray(value.items)) {
		throw new Error("invalid runtime plan in session");
	}
	if (value.items.length > 1_000) {
		throw new Error("runtime plan is too large");
	}
	const items = value.items.map((entry, index) => {
		if (
			!isRecord(entry) ||
			typeof entry.step !== "string" ||
			entry.step.trim().length === 0 ||
			!(["pending", "in_progress", "completed"] as unknown[]).includes(
				entry.status,
			)
		) {
			throw new Error(`invalid runtime plan item at index ${index}`);
		}
		return {
			step: entry.step,
			status: entry.status as "pending" | "in_progress" | "completed",
		};
	});
	return {
		explanation:
			typeof value.explanation === "string" ? value.explanation : undefined,
		items,
	};
}

function normalizeRestoredBudget(value: unknown): BudgetState {
	if (!isRecord(value)) {
		return { turnsUsed: 0, maxTurns: 20 };
	}
	const maxTurns = boundedPositiveInteger(value.maxTurns, 20, 100);
	return {
		turnsUsed: boundedNonNegativeInteger(value.turnsUsed, 0, maxTurns),
		maxTurns,
	};
}

function boundedPositiveInteger(
	value: unknown,
	fallback: number,
	maximum: number,
): number {
	return Number.isSafeInteger(value) && Number(value) > 0
		? Math.min(Number(value), maximum)
		: fallback;
}

function boundedNonNegativeInteger(
	value: unknown,
	fallback: number,
	maximum: number,
): number {
	return Number.isSafeInteger(value) && Number(value) >= 0
		? Math.min(Number(value), maximum)
		: fallback;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (isRecord(value)) {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (caught) {
		if (isNotFoundError(caught)) {
			return false;
		}
		throw caught;
	}
}

function isNotFoundError(caught: unknown): boolean {
	return (
		typeof caught === "object" &&
		caught !== null &&
		"code" in caught &&
		caught.code === "ENOENT"
	);
}

function formatCaught(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}
