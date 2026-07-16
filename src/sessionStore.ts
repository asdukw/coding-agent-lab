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
	type Message,
	normalizeToolPermissionContext,
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
			toolPermissionContext: state.toolPermissionContext,
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
				toolPermissionContext: state.toolPermissionContext,
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
		return fromStoredSessionState(replaySessionEvents(raw, sessionId, cwd));
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

	return fromStoredSessionState(storedState);
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
): AgentState {
	const budget = state.budget ?? { turnsUsed: 0, maxTurns: 20 };
	const cwd = state.cwd ?? process.cwd();
	const messages = state.messages ?? [];
	return {
		agent: {
			id: state.sessionId ?? "",
			type:
				state.toolPermissionContext?.agentType === "memory" ? "memory" : "main",
			depth: state.toolPermissionContext?.agentType === "memory" ? 1 : 0,
		},
		sessionId: state.sessionId ?? "",
		task: state.task ?? "",
		cwd,
		toolSpecs: toToolSpecs(BUILTIN_TOOLS),
		toolPermissionContext: normalizeToolPermissionContext(
			state.toolPermissionContext,
			cwd,
		),
		plan: state.plan ?? { items: [] },
		messages,
		todos: [],
		observations: [],
		toolExecutions: state.toolExecutions?.length
			? state.toolExecutions
			: deriveToolExecutions(messages),
		changedFiles: state.changedFiles ?? [],
		turn: state.turn ?? budget.turnsUsed,
		maxTurns: budget.maxTurns,
		budget,
		compaction: state.compaction ?? { consecutiveFailures: 0 },
		transition: { reason: "start" },
	};
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
