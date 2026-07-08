import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { AgentState } from "./state";

const SESSION_DIR = ".cagent/sessions";
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export type StoredSession = {
	version: 1;
	id: string;
	savedAt: string;
	state: AgentState;
};

export function getSessionPath(cwd: string, sessionId: string): string {
	if (
		!SESSION_ID_PATTERN.test(sessionId) ||
		sessionId === "." ||
		sessionId === ".."
	) {
		throw new Error(`invalid session id: ${sessionId}`);
	}

	const sessionsDir = resolve(cwd, SESSION_DIR);
	const sessionPath = resolve(sessionsDir, `${sessionId}.json`);

	if (
		!sessionPath.startsWith(`${sessionsDir}${sep}`) &&
		sessionPath !== sessionsDir
	) {
		throw new Error(`invalid session path for id: ${sessionId}`);
	}

	return sessionPath;
}

export async function saveSession(
	cwd: string,
	state: AgentState,
): Promise<string> {
	const path = getSessionPath(cwd, state.sessionId);
	const stored: StoredSession = {
		version: 1,
		id: state.sessionId,
		savedAt: new Date().toISOString(),
		state,
	};

	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
	return path;
}

export async function loadSession(
	cwd: string,
	sessionId: string,
): Promise<AgentState> {
	const path = getSessionPath(cwd, sessionId);
	const raw = await readFile(path, "utf8");
	const parsed = JSON.parse(raw) as Partial<StoredSession>;

	if (parsed.version !== 1 || parsed.id !== sessionId || !parsed.state) {
		throw new Error(`invalid session file: ${path}`);
	}

	if (parsed.state.sessionId !== sessionId) {
		throw new Error(`session id mismatch in file: ${path}`);
	}

	return parsed.state;
}
