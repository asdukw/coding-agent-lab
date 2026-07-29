import { randomUUID } from "node:crypto";
import {
	access,
	appendFile,
	mkdir,
	open,
	readFile,
	rename,
	rm,
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
	type ToolFailure,
	type ToolPermissionContext,
	type ToolResultMetadata,
} from "./state";
import {
	deriveToolExecutions,
	parseToolArguments,
	recordToolCall,
	recordToolResult,
	type ToolExecution,
	toolResultOutcome,
} from "./toolExecutionMemory";
import { BUILTIN_TOOLS } from "./tools";
import { toToolSpecs } from "./tools/types";

const SESSION_DIR = ".cagent/sessions";
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SESSION_INDEX_FILE = "session_index.jsonl";
const MEMORY_EXTRACTION_AUDIT_DIR = ".cagent/audit/memory-extraction";
// Serialize asynchronous writers within this process. Cross-process locking is a
// separate sandbox/runtime concern and is not provided by this queue.
const writeTails = new Map<string, Promise<void>>();

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
	return serializeWrite(path, () => ensureSessionStartedUnlocked(cwd, state));
}

async function ensureSessionStartedUnlocked(
	cwd: string,
	state: AgentState,
): Promise<string> {
	const path = getSessionPath(cwd, state.sessionId);
	if (await pathExists(path)) {
		return path;
	}

	await appendSessionEventUnlocked(cwd, {
		version: 2,
		timestamp: new Date().toISOString(),
		type: "session_meta",
		sessionId: state.sessionId,
		payload: {
			cwd: state.cwd,
			task: state.task,
		},
	});
	await updateSessionIndex(cwd, state);
	return path;
}

export async function appendSessionMessage(
	cwd: string,
	state: AgentState,
	message: Message,
): Promise<void> {
	const path = getSessionPath(cwd, state.sessionId);
	await serializeWrite(path, async () => {
		await ensureSessionStartedUnlocked(cwd, state);
		for (const event of createMessageEvents(state.sessionId, message)) {
			await appendSessionEventUnlocked(cwd, event);
		}
	});
}

export async function appendSessionState(
	cwd: string,
	state: AgentState,
): Promise<void> {
	const path = getSessionPath(cwd, state.sessionId);
	await serializeWrite(path, async () => {
		await ensureSessionStartedUnlocked(cwd, state);
		await appendSessionEventUnlocked(cwd, {
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
		await updateSessionIndex(cwd, state);
	});
}

export async function appendSessionCompaction(
	cwd: string,
	state: AgentState,
): Promise<void> {
	const path = getSessionPath(cwd, state.sessionId);
	await serializeWrite(path, async () => {
		await ensureSessionStartedUnlocked(cwd, state);
		await appendSessionEventUnlocked(cwd, {
			version: 2,
			timestamp: new Date().toISOString(),
			type: "context_compaction",
			sessionId: state.sessionId,
			payload: {
				messages: state.messages,
				compaction: state.compaction,
			},
		});
		await updateSessionIndex(cwd, state);
	});
}

export async function appendSessionMemoryExtraction(
	cwd: string,
	state: AgentState,
	result: SessionMemoryExtractionResult,
): Promise<void> {
	const path = getSessionPath(cwd, state.sessionId);
	await serializeWrite(path, async () => {
		await ensureSessionStartedUnlocked(cwd, state);
		await appendSessionEventUnlocked(cwd, {
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
	return serializeWrite(path, async () => {
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
		await atomicReplaceFile(
			path,
			`${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
		);
		await updateSessionIndex(cwd, state);
		return path;
	});
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

async function appendSessionEventUnlocked(
	cwd: string,
	event: SessionEvent,
): Promise<void> {
	const path = getSessionPath(cwd, event.sessionId);
	await mkdir(dirname(path), { recursive: true });
	await truncateIncompleteTail(path);
	await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

async function updateSessionIndex(
	cwd: string,
	state: AgentState,
): Promise<void> {
	const indexPath = getSessionIndexPath(cwd);
	await serializeWrite(indexPath, async () => {
		const sessionPath = getSessionPath(cwd, state.sessionId);
		const entry: SessionIndexEntry = {
			version: 1,
			sessionId: state.sessionId,
			cwd: resolve(cwd),
			task: state.task,
			path: relative(resolve(cwd), sessionPath),
			updatedAt: new Date().toISOString(),
		};

		await mkdir(dirname(indexPath), { recursive: true });
		const entries = await readSessionIndex(indexPath, cwd);
		const latestBySession = new Map(
			entries.map((existing) => [existing.sessionId, existing]),
		);
		latestBySession.set(entry.sessionId, entry);
		await atomicReplaceFile(
			indexPath,
			`${[...latestBySession.values()]
				.map((latest) => JSON.stringify(latest))
				.join("\n")}\n`,
		);
	});
}

async function readSessionIndex(
	indexPath: string,
	cwd: string,
): Promise<SessionIndexEntry[]> {
	let raw: string;
	try {
		raw = await readFile(indexPath, "utf8");
	} catch (caught) {
		if (isNotFoundError(caught)) {
			return [];
		}
		throw caught;
	}
	if (raw.length === 0) {
		return [];
	}

	const lines = raw.split(/\r?\n/);
	const hasTerminatingNewline = /\r?\n$/.test(raw);
	const latestBySession = new Map<string, SessionIndexEntry>();
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) {
			const isTerminatingLine =
				index === lines.length - 1 && line === "" && hasTerminatingNewline;
			if (isTerminatingLine) {
				continue;
			}
			throw new Error(
				`invalid session index entry at line ${index + 1}: empty records are not allowed`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch (caught) {
			const isIncompleteTail =
				index === lines.length - 1 && !hasTerminatingNewline;
			if (isIncompleteTail) {
				break;
			}
			throw new Error(
				`invalid session index entry at line ${index + 1}: ${formatCaught(caught)}`,
			);
		}

		let entry: SessionIndexEntry;
		try {
			entry = decodeSessionIndexEntry(parsed, cwd);
		} catch (caught) {
			throw new Error(
				`invalid session index entry at line ${index + 1}: ${formatCaught(caught)}`,
			);
		}
		// The index used to be an append-only update log. Preserve the last
		// committed occurrence while migrating it to one current row per session.
		latestBySession.set(entry.sessionId, entry);
	}
	return [...latestBySession.values()];
}

function decodeSessionIndexEntry(
	value: unknown,
	cwd: string,
): SessionIndexEntry {
	const entry = requireSessionRecord(value, "session index entry");
	assertSessionKeys(
		entry,
		["version", "sessionId", "cwd", "task", "path", "updatedAt"],
		[],
		"session index entry",
	);
	if (entry.version !== 1) {
		throw new Error("session index entry.version must be 1");
	}
	const sessionId = requireSessionId(entry, "session index entry");
	requireNonEmptySessionString(entry, "cwd", "session index entry");
	const task = requireSessionString(entry, "task", "session index entry");
	const path = requireNonEmptySessionString(
		entry,
		"path",
		"session index entry",
	);
	const expectedPath = relative(resolve(cwd), getSessionPath(cwd, sessionId));
	if (path !== expectedPath) {
		throw new Error(
			`session index entry.path does not match sessionId ${sessionId}`,
		);
	}
	const updatedAt = requireSessionTimestamp(
		entry,
		"updatedAt",
		"session index entry",
	);
	return {
		version: 1,
		sessionId,
		cwd: resolve(cwd),
		task,
		path,
		updatedAt,
	};
}

async function serializeWrite<T>(
	path: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = writeTails.get(path) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((resolveGate) => {
		release = resolveGate;
	});
	const tail = previous.catch(() => undefined).then(() => gate);
	writeTails.set(path, tail);

	await previous.catch(() => undefined);
	try {
		return await operation();
	} finally {
		release();
		if (writeTails.get(path) === tail) {
			writeTails.delete(path);
		}
	}
}

async function atomicReplaceFile(path: string, content: string): Promise<void> {
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporaryPath, path);
	} catch (caught) {
		await handle?.close().catch(() => undefined);
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw caught;
	}
}

async function truncateIncompleteTail(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, "r+");
	} catch (caught) {
		if (isNotFoundError(caught)) {
			return;
		}
		throw caught;
	}

	try {
		const { size } = await handle.stat();
		let cursor = size;
		while (cursor > 0) {
			const length = Math.min(cursor, 4_096);
			const position = cursor - length;
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, position);
			for (let index = bytesRead - 1; index >= 0; index--) {
				if (buffer[index] !== 0x0a) {
					continue;
				}
				const completeLength = position + index + 1;
				if (completeLength < size) {
					await handle.truncate(completeLength);
					await handle.sync();
				}
				return;
			}
			cursor = position;
		}

		await handle.truncate(0);
		await handle.sync();
	} finally {
		await handle.close();
	}
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

	const lines = raw.split(/\r?\n/);
	const hasTerminatingNewline = /\r?\n$/.test(raw);
	let parsedEventCount = 0;
	let metadataSeen = false;
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) {
			const isTerminatingLine =
				index === lines.length - 1 && line === "" && hasTerminatingNewline;
			if (isTerminatingLine) {
				continue;
			}
			throw new Error(
				`invalid session event at line ${index + 1}: empty records are not allowed`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch (caught) {
			const isIncompleteTail =
				index === lines.length - 1 &&
				!hasTerminatingNewline &&
				parsedEventCount > 0;
			if (isIncompleteTail) {
				break;
			}
			throw new Error(
				`invalid session event at line ${index + 1}: ${formatCaught(caught)}`,
			);
		}
		let event: SessionEvent | LegacySessionEvent;
		try {
			event = decodeSessionEvent(parsed);
		} catch (caught) {
			throw new Error(
				`invalid session event at line ${index + 1}: ${formatCaught(caught)}`,
			);
		}
		const isMetadata =
			event.type === "session_meta" || event.type === "session_start";
		if (parsedEventCount === 0 && !isMetadata) {
			throw new Error(
				`invalid session event at line ${index + 1}: first event must contain session metadata`,
			);
		}
		if (isMetadata && metadataSeen) {
			throw new Error(
				`invalid session event at line ${index + 1}: duplicate session metadata`,
			);
		}
		metadataSeen ||= isMetadata;
		parsedEventCount++;
		if (event.sessionId !== sessionId) {
			throw new Error(
				`invalid session event at line ${index + 1}: session id mismatch; expected ${sessionId}`,
			);
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

function decodeSessionEvent(value: unknown): SessionEvent | LegacySessionEvent {
	const event = requireSessionRecord(value, "session event");
	const type = requireSessionString(event, "type", "session event");

	if (event.version === 2) {
		assertSessionKeys(
			event,
			["version", "timestamp", "type", "sessionId", "payload"],
			[],
			"session event",
		);
		requireSessionId(event, "session event");
		requireSessionTimestamp(event, "timestamp", "session event");
		const payload = requireSessionRecord(event.payload, `${type} payload`);

		if (type === "session_meta") {
			assertSessionKeys(payload, ["cwd", "task"], [], `${type} payload`);
			requireSessionString(payload, "cwd", `${type} payload`);
			requireSessionString(payload, "task", `${type} payload`);
		} else if (
			type === "user_message" ||
			type === "agent_message" ||
			type === "assistant_message" ||
			type === "tool_result"
		) {
			assertSessionKeys(payload, ["message"], [], `${type} payload`);
			const message = validateSessionMessage(
				payload.message,
				`${type} payload`,
			);
			const allowedRoles: Record<typeof type, Message["role"][]> = {
				user_message: ["user"],
				agent_message: ["agent"],
				assistant_message: ["assistant", "system"],
				tool_result: ["tool"],
			};
			if (!allowedRoles[type].includes(message.role)) {
				throw new Error(`${type} payload has incompatible message role`);
			}
		} else if (type === "tool_call") {
			assertSessionKeys(
				payload,
				["id", "name", "arguments"],
				[],
				`${type} payload`,
			);
			requireNonEmptySessionString(payload, "id", `${type} payload`);
			requireNonEmptySessionString(payload, "name", `${type} payload`);
			requireSessionString(payload, "arguments", `${type} payload`);
		} else if (type === "state_snapshot") {
			validateStateSnapshotPayload(payload);
		} else if (type === "context_compaction") {
			assertSessionKeys(
				payload,
				["messages", "compaction"],
				[],
				`${type} payload`,
			);
			validateSessionMessageArray(payload.messages, `${type} payload messages`);
			validateCompaction(payload.compaction, `${type} payload compaction`);
		} else if (type === "memory_extraction") {
			validateMemoryExtractionPayload(payload, `${type} payload`);
		} else {
			throw new Error(`unsupported session event type: ${type}`);
		}

		return event as SessionEvent;
	}

	if (event.version !== undefined && event.version !== 1) {
		throw new Error(
			`unsupported session event version: ${String(event.version)}`,
		);
	}

	if (type === "session_start") {
		assertSessionKeys(
			event,
			["type", "version", "sessionId", "cwd", "task", "createdAt"],
			[],
			"legacy session_start event",
		);
		if (event.version !== 1) {
			throw new Error("legacy session_start event must use version 1");
		}
		requireSessionId(event, "legacy session_start event");
		requireSessionString(event, "cwd", "legacy session_start event");
		requireSessionString(event, "task", "legacy session_start event");
		requireSessionTimestamp(event, "createdAt", "legacy session_start event");
	} else if (type === "message") {
		assertSessionKeys(
			event,
			["type", "sessionId", "message", "createdAt"],
			[],
			"legacy message event",
		);
		requireSessionId(event, "legacy message event");
		validateSessionMessage(event.message, "legacy message event");
		requireSessionTimestamp(event, "createdAt", "legacy message event");
	} else if (type === "state") {
		assertSessionKeys(
			event,
			[
				"type",
				"sessionId",
				"task",
				"toolPermissionContext",
				"plan",
				"turn",
				"budget",
				"savedAt",
			],
			[],
			"legacy state event",
		);
		requireSessionId(event, "legacy state event");
		requireSessionString(event, "task", "legacy state event");
		validatePermissionContext(
			event.toolPermissionContext,
			"legacy state event",
		);
		normalizeRestoredPlan(event.plan);
		requireNonNegativeSessionInteger(event, "turn", "legacy state event");
		validateBudget(event.budget, "legacy state event budget");
		requireSessionTimestamp(event, "savedAt", "legacy state event");
	} else if (type === "memory_extraction") {
		assertSessionKeys(
			event,
			["type", "sessionId", "subAgentSessionId", "ok", "summary", "createdAt"],
			[],
			"legacy memory_extraction event",
		);
		requireSessionId(event, "legacy memory_extraction event");
		requireNonEmptySessionString(
			event,
			"subAgentSessionId",
			"legacy memory_extraction event",
		);
		requireSessionBoolean(event, "ok", "legacy memory_extraction event");
		requireSessionString(event, "summary", "legacy memory_extraction event");
		requireSessionTimestamp(
			event,
			"createdAt",
			"legacy memory_extraction event",
		);
	} else {
		throw new Error(`unsupported legacy session event type: ${type}`);
	}

	return event as LegacySessionEvent;
}

function validateStateSnapshotPayload(payload: Record<string, unknown>): void {
	const label = "state_snapshot payload";
	assertSessionKeys(
		payload,
		["task", "toolPermissionContext", "plan", "turn", "budget", "compaction"],
		["toolExecutions", "changedFiles"],
		label,
	);
	requireSessionString(payload, "task", label);
	validatePermissionContext(payload.toolPermissionContext, label);
	normalizeRestoredPlan(payload.plan);
	requireNonNegativeSessionInteger(payload, "turn", label);
	validateBudget(payload.budget, `${label} budget`);
	validateCompaction(payload.compaction, `${label} compaction`);
	if (payload.toolExecutions !== undefined) {
		validateToolExecutions(payload.toolExecutions, `${label} toolExecutions`);
	}
	if (payload.changedFiles !== undefined) {
		validateStringArray(payload.changedFiles, `${label} changedFiles`);
	}
}

function validateMemoryExtractionPayload(
	payload: Record<string, unknown>,
	label: string,
): void {
	assertSessionKeys(
		payload,
		["subAgentSessionId", "ok", "summary"],
		["reason", "reasons"],
		label,
	);
	requireNonEmptySessionString(payload, "subAgentSessionId", label);
	requireSessionBoolean(payload, "ok", label);
	requireSessionString(payload, "summary", label);
	if (payload.reason !== undefined && typeof payload.reason !== "string") {
		throw new Error(`${label}.reason must be a string`);
	}
	if (payload.reasons !== undefined) {
		validateStringArray(payload.reasons, `${label}.reasons`);
	}
}

function validateSessionMessageArray(value: unknown, label: string): Message[] {
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array`);
	}
	return value.map((entry, index) =>
		validateSessionMessage(entry, `${label}[${index}]`),
	);
}

function validateSessionMessage(value: unknown, label: string): Message {
	const message = requireSessionRecord(value, label);
	const role = requireSessionString(message, "role", label);
	if (!["user", "assistant", "tool", "system", "agent"].includes(role)) {
		throw new Error(`${label}.role is invalid`);
	}
	const allowedKeys = [
		"role",
		"content",
		"containsUntrustedAgentContent",
		"origin",
	];
	if (role === "assistant") {
		allowedKeys.push("toolCalls");
	} else if (role === "tool") {
		allowedKeys.push("toolCallId", "toolResult");
	}
	assertSessionKeys(message, ["role", "content"], allowedKeys.slice(2), label);
	requireSessionString(message, "content", label);
	if (
		message.containsUntrustedAgentContent !== undefined &&
		typeof message.containsUntrustedAgentContent !== "boolean"
	) {
		throw new Error(`${label}.containsUntrustedAgentContent must be a boolean`);
	}
	if (message.origin !== undefined && message.origin !== "approval") {
		throw new Error(`${label}.origin must be approval`);
	}
	if (message.origin === "approval" && role !== "user") {
		throw new Error(`${label}.origin is only allowed on user messages`);
	}
	if (role === "assistant" && message.toolCalls !== undefined) {
		validateSessionToolCalls(message.toolCalls, `${label}.toolCalls`);
	}
	if (role === "tool") {
		requireNonEmptySessionString(message, "toolCallId", label);
		if (message.toolResult !== undefined) {
			validateToolResultMetadata(message.toolResult, `${label}.toolResult`);
		}
	}
	validateRestoredMessages([message]);
	return message as Message;
}

function validateToolResultMetadata(
	value: unknown,
	label: string,
): ToolResultMetadata {
	const result = requireSessionRecord(value, label);
	const status = requireSessionString(result, "status", label);
	if (status === "succeeded") {
		assertSessionKeys(result, ["status"], [], label);
		return { status };
	}
	if (status !== "failed") {
		throw new Error(`${label}.status is invalid`);
	}
	assertSessionKeys(result, ["status", "failure"], [], label);
	return {
		status,
		failure: validateToolFailure(result.failure, `${label}.failure`),
	};
}

function validateToolFailure(value: unknown, label: string): ToolFailure {
	const failure = requireSessionRecord(value, label);
	assertSessionKeys(failure, ["kind", "message"], ["stage", "exitCode"], label);
	const kind = requireSessionString(failure, "kind", label);
	if (
		![
			"permission_denied",
			"backend_unavailable",
			"command_failed",
			"runtime_error",
		].includes(kind)
	) {
		throw new Error(`${label}.kind is invalid`);
	}
	const message = requireSessionString(failure, "message", label);
	if (failure.stage !== undefined && typeof failure.stage !== "string") {
		throw new Error(`${label}.stage must be a string`);
	}
	if (
		failure.exitCode !== undefined &&
		(typeof failure.exitCode !== "number" ||
			!Number.isSafeInteger(failure.exitCode))
	) {
		throw new Error(`${label}.exitCode must be an integer`);
	}
	return {
		kind: kind as ToolFailure["kind"],
		message,
		...(typeof failure.stage === "string" ? { stage: failure.stage } : {}),
		...(typeof failure.exitCode === "number"
			? { exitCode: failure.exitCode }
			: {}),
	};
}

function validateSessionToolCalls(value: unknown, label: string): void {
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array`);
	}
	const ids = new Set<string>();
	for (const [index, entry] of value.entries()) {
		const call = requireSessionRecord(entry, `${label}[${index}]`);
		assertSessionKeys(
			call,
			["id", "name", "arguments"],
			[],
			`${label}[${index}]`,
		);
		const id = requireNonEmptySessionString(call, "id", `${label}[${index}]`);
		requireNonEmptySessionString(call, "name", `${label}[${index}]`);
		requireSessionString(call, "arguments", `${label}[${index}]`);
		if (ids.has(id)) {
			throw new Error(`${label} contains duplicate id: ${id}`);
		}
		ids.add(id);
	}
}

function validatePermissionContext(value: unknown, label: string): void {
	const context = requireSessionRecord(value, `${label} toolPermissionContext`);
	assertSessionKeys(
		context,
		["mode"],
		[
			"agentType",
			"approvalMode",
			"writePolicy",
			"sessionAllowedTools",
			"prePlanMode",
			"pendingPlanApproval",
			"pendingToolApproval",
		],
		`${label} toolPermissionContext`,
	);
	if (context.mode !== "normal" && context.mode !== "plan") {
		throw new Error(`${label} toolPermissionContext.mode is invalid`);
	}
	if (
		context.agentType !== undefined &&
		context.agentType !== "main" &&
		context.agentType !== "memory" &&
		context.agentType !== "subagent"
	) {
		throw new Error(`${label} toolPermissionContext.agentType is invalid`);
	}
	if (
		context.approvalMode !== undefined &&
		context.approvalMode !== "ask" &&
		context.approvalMode !== "auto" &&
		context.approvalMode !== "full_access"
	) {
		throw new Error(`${label} toolPermissionContext.approvalMode is invalid`);
	}
	if (context.sessionAllowedTools !== undefined) {
		validateStringArray(
			context.sessionAllowedTools,
			`${label} toolPermissionContext.sessionAllowedTools`,
		);
	}
	if (context.writePolicy !== undefined) {
		const policy = requireSessionRecord(
			context.writePolicy,
			`${label} toolPermissionContext.writePolicy`,
		);
		assertSessionKeys(
			policy,
			[],
			["allow", "deny"],
			`${label} toolPermissionContext.writePolicy`,
		);
		if (policy.allow !== undefined) {
			validateStringArray(
				policy.allow,
				`${label} toolPermissionContext.writePolicy.allow`,
			);
		}
		if (policy.deny !== undefined) {
			validateStringArray(
				policy.deny,
				`${label} toolPermissionContext.writePolicy.deny`,
			);
		}
	}
	if (
		context.prePlanMode !== undefined &&
		context.prePlanMode !== "normal" &&
		context.prePlanMode !== "plan"
	) {
		throw new Error(`${label} toolPermissionContext.prePlanMode is invalid`);
	}
	normalizeRestoredPendingPlanApproval(context.pendingPlanApproval);
	validateRestoredPendingToolApproval(context.pendingToolApproval);
}

function validateBudget(value: unknown, label: string): void {
	const budget = requireSessionRecord(value, label);
	assertSessionKeys(budget, ["turnsUsed", "maxTurns"], [], label);
	const turnsUsed = requireNonNegativeSessionInteger(
		budget,
		"turnsUsed",
		label,
	);
	const maxTurns = requirePositiveSessionInteger(budget, "maxTurns", label);
	if (turnsUsed > maxTurns) {
		throw new Error(`${label}.turnsUsed must not exceed maxTurns`);
	}
}

function validateCompaction(value: unknown, label: string): void {
	const compaction = requireSessionRecord(value, label);
	assertSessionKeys(compaction, ["consecutiveFailures"], [], label);
	requireNonNegativeSessionInteger(compaction, "consecutiveFailures", label);
}

function validateToolExecutions(value: unknown, label: string): void {
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array`);
	}
	for (const [index, entry] of value.entries()) {
		const execution = requireSessionRecord(entry, `${label}[${index}]`);
		assertSessionKeys(
			execution,
			["callId", "tool", "status"],
			["target", "turn", "timestamp", "failure"],
			`${label}[${index}]`,
		);
		requireNonEmptySessionString(execution, "callId", `${label}[${index}]`);
		requireNonEmptySessionString(execution, "tool", `${label}[${index}]`);
		if (
			!["succeeded", "failed", "unknown"].includes(String(execution.status))
		) {
			throw new Error(`${label}[${index}].status is invalid`);
		}
		if (
			execution.target !== undefined &&
			typeof execution.target !== "string"
		) {
			throw new Error(`${label}[${index}].target must be a string`);
		}
		if (execution.turn !== undefined) {
			requireNonNegativeSessionInteger(execution, "turn", `${label}[${index}]`);
		}
		if (execution.timestamp !== undefined) {
			requireSessionTimestamp(execution, "timestamp", `${label}[${index}]`);
		}
		if (execution.failure !== undefined) {
			validateToolFailure(execution.failure, `${label}[${index}].failure`);
			if (execution.status !== "failed") {
				throw new Error(`${label}[${index}].failure requires failed status`);
			}
		}
	}
}

function validateStringArray(value: unknown, label: string): string[] {
	if (
		!Array.isArray(value) ||
		value.some((entry) => typeof entry !== "string")
	) {
		throw new Error(`${label} must be an array of strings`);
	}
	return value as string[];
}

function requireSessionRecord(
	value: unknown,
	label: string,
): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value;
}

function assertSessionKeys(
	record: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
	label: string,
): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of required) {
		if (!Object.hasOwn(record, key)) {
			throw new Error(`${label}.${key} is required`);
		}
	}
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) {
			throw new Error(`${label}.${key} is not allowed`);
		}
	}
}

function requireSessionString(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string {
	const value = record[key];
	if (typeof value !== "string") {
		throw new Error(`${label}.${key} must be a string`);
	}
	return value;
}

function requireNonEmptySessionString(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string {
	const value = requireSessionString(record, key, label);
	if (!value.trim()) {
		throw new Error(`${label}.${key} must not be empty`);
	}
	return value;
}

function requireSessionId(
	record: Record<string, unknown>,
	label: string,
): string {
	const value = requireNonEmptySessionString(record, "sessionId", label);
	if (!SESSION_ID_PATTERN.test(value) || value === "." || value === "..") {
		throw new Error(`${label}.sessionId is invalid`);
	}
	return value;
}

function requireSessionBoolean(
	record: Record<string, unknown>,
	key: string,
	label: string,
): boolean {
	const value = record[key];
	if (typeof value !== "boolean") {
		throw new Error(`${label}.${key} must be a boolean`);
	}
	return value;
}

function requireNonNegativeSessionInteger(
	record: Record<string, unknown>,
	key: string,
	label: string,
): number {
	const value = record[key];
	if (!Number.isSafeInteger(value) || Number(value) < 0) {
		throw new Error(`${label}.${key} must be a non-negative integer`);
	}
	return Number(value);
}

function requirePositiveSessionInteger(
	record: Record<string, unknown>,
	key: string,
	label: string,
): number {
	const value = record[key];
	if (!Number.isSafeInteger(value) || Number(value) <= 0) {
		throw new Error(`${label}.${key} must be a positive integer`);
	}
	return Number(value);
}

function requireSessionTimestamp(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string {
	const value = requireNonEmptySessionString(record, key, label);
	if (!Number.isFinite(Date.parse(value))) {
		throw new Error(`${label}.${key} must be a valid timestamp`);
	}
	return value;
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
						toolResultOutcome(message),
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
		// Approval policy is process-local authority and cannot be restored.
		approvalMode: "ask",
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
		// Persist only the safe default, never a less restrictive process choice.
		approvalMode: "ask",
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
		const origin = validateRestoredMessageOrigin(entry, index);
		if (entry.role !== "tool" && entry.toolResult !== undefined) {
			throw new Error(`toolResult is only allowed on tool message ${index}`);
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
			const toolResult =
				entry.toolResult === undefined
					? undefined
					: validateToolResultMetadata(
							entry.toolResult,
							`message ${index}.toolResult`,
						);
			return {
				role: "tool",
				content: entry.content,
				toolCallId: entry.toolCallId,
				...(toolResult ? { toolResult } : {}),
				...(untrusted ? { containsUntrustedAgentContent: true } : {}),
			};
		}
		if (entry.role === "user") {
			return {
				role: "user",
				content: entry.content,
				...(origin ? { origin } : {}),
				...(untrusted ? { containsUntrustedAgentContent: true } : {}),
			};
		}
		throw new Error(`invalid session message role at index ${index}`);
	});
}

function validateRestoredMessageOrigin(
	entry: Record<string, unknown>,
	index: number,
): "approval" | undefined {
	if (entry.origin === undefined) {
		return undefined;
	}
	if (entry.origin !== "approval") {
		throw new Error(`invalid message origin at index ${index}`);
	}
	if (entry.role !== "user") {
		throw new Error(`approval origin is only allowed on user message ${index}`);
	}
	return "approval";
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
