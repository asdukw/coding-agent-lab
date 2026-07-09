import {
	access,
	appendFile,
	mkdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
	type AgentState,
	type BudgetState,
	createToolPermissionContext,
	type Message,
	type RuntimePlan,
	type ToolPermissionContext,
} from "./state";
import { BUILTIN_TOOLS } from "./tools";
import { toToolSpecs } from "./tools/types";

const SESSION_DIR = ".cagent/sessions";
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SESSION_INDEX_FILE = "session_index.jsonl";

export type StoredSessionState = {
	sessionId: string;
	task: string;
	cwd: string;
	toolPermissionContext?: ToolPermissionContext;
	plan?: RuntimePlan;
	messages: Message[];
	turn: number;
	budget: BudgetState;
};

export type StoredSession = {
	version: 1;
	id: string;
	savedAt: string;
	state: StoredSessionState;
};

export type SessionEvent =
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
		type: "session_start",
		version: 1,
		sessionId: state.sessionId,
		cwd: state.cwd,
		task: state.task,
		createdAt: new Date().toISOString(),
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
	await appendSessionEvent(cwd, {
		type: "message",
		sessionId: state.sessionId,
		message,
		createdAt: new Date().toISOString(),
	});
}

export async function appendSessionState(
	cwd: string,
	state: AgentState,
): Promise<void> {
	await ensureSessionStarted(cwd, state);
	await appendSessionEvent(cwd, {
		type: "state",
		sessionId: state.sessionId,
		task: state.task,
		toolPermissionContext: state.toolPermissionContext,
		plan: state.plan,
		turn: state.turn,
		budget: state.budget,
		savedAt: new Date().toISOString(),
	});
	await appendSessionIndex(cwd, state);
}

export async function appendSessionMemoryExtraction(
	cwd: string,
	state: AgentState,
	result: {
		subAgentSessionId: string;
		ok: boolean;
		summary: string;
	},
): Promise<void> {
	await ensureSessionStarted(cwd, state);
	await appendSessionEvent(cwd, {
		type: "memory_extraction",
		sessionId: state.sessionId,
		subAgentSessionId: result.subAgentSessionId,
		ok: result.ok,
		summary: result.summary,
		createdAt: new Date().toISOString(),
	});
}

export async function saveSession(
	cwd: string,
	state: AgentState,
): Promise<string> {
	const path = getSessionPath(cwd, state.sessionId);
	const events: SessionEvent[] = [
		{
			type: "session_start",
			version: 1,
			sessionId: state.sessionId,
			cwd: state.cwd,
			task: state.task,
			createdAt: new Date().toISOString(),
		},
		...state.messages.map((message): SessionEvent => {
			return {
				type: "message",
				sessionId: state.sessionId,
				message,
				createdAt: new Date().toISOString(),
			};
		}),
		{
			type: "state",
			sessionId: state.sessionId,
			task: state.task,
			toolPermissionContext: state.toolPermissionContext,
			plan: state.plan,
			turn: state.turn,
			budget: state.budget,
			savedAt: new Date().toISOString(),
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
		turn: 0,
		budget: { turnsUsed: 0, maxTurns: 20 },
	};

	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) {
			continue;
		}

		const event = JSON.parse(line) as SessionEvent;
		if (event.sessionId !== sessionId) {
			throw new Error(`session id mismatch in event: ${sessionId}`);
		}

		if (event.type === "session_start") {
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
	return {
		sessionId: state.sessionId ?? "",
		task: state.task ?? "",
		cwd,
		toolSpecs: toToolSpecs(BUILTIN_TOOLS),
		toolPermissionContext:
			state.toolPermissionContext ?? createToolPermissionContext(),
		plan: state.plan ?? { items: [] },
		messages: state.messages ?? [],
		todos: [],
		observations: [],
		changedFiles: [],
		turn: state.turn ?? budget.turnsUsed,
		maxTurns: budget.maxTurns,
		budget,
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
