import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../src/main";
import {
	appendSessionMemoryExtraction,
	appendSessionMessage,
	appendSessionState,
	ensureSessionStarted,
	getSessionIndexPath,
	getSessionPath,
	loadSession,
	saveSession,
} from "../src/sessionStore";
import { type AgentState, createInitialState } from "../src/state";

test("saveSession writes JSONL events and loadSession hydrates runtime fields", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state: AgentState = {
			...createInitialState("hello", cwd, [], "session-1"),
			finalAnswer: "hello back",
			observations: [
				{
					tool: "Read",
					args: { file_path: "README.md" },
					ok: true,
					output: "content",
				},
			],
			messages: [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hello back" },
			],
		};
		const path = await saveSession(cwd, state);

		expect(path).toBe(getSessionPath(cwd, "session-1"));
		const raw = await readFile(path, "utf8");
		expect(raw).toContain('"version":1');
		expect(raw).toContain('"sessionId":"session-1"');
		expect(raw).not.toContain('"toolSpecs"');
		expect(raw).not.toContain('"inputSchema"');
		expect(raw).not.toContain('"finalAnswer"');
		expect(raw).not.toContain('"observations"');
		const events = raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string });
		expect(events.map((event) => event.type)).toEqual([
			"session_start",
			"message",
			"message",
			"state",
		]);

		const restored = await loadSession(cwd, "session-1");
		expect(restored.sessionId).toBe("session-1");
		expect(restored.messages).toEqual(state.messages);
		expect(restored.toolSpecs.map((tool) => tool.name)).toContain("Read");
		expect(restored.finalAnswer).toBeUndefined();
		expect(restored.observations).toEqual([]);
		expect(restored.changedFiles).toEqual([]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("append APIs persist messages immediately and update the session index", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state = createInitialState("hello", cwd, [], "append-1");
		const userMessage = state.messages[0];
		if (!userMessage) {
			throw new Error("expected initial user message");
		}
		await ensureSessionStarted(cwd, state);
		await appendSessionMessage(cwd, state, userMessage);
		const assistant = { role: "assistant" as const, content: "hello back" };
		const nextState: AgentState = {
			...state,
			messages: [...state.messages, assistant],
			turn: 1,
			budget: { turnsUsed: 1, maxTurns: 20 },
		};
		await appendSessionMessage(cwd, nextState, assistant);
		await appendSessionState(cwd, nextState);

		const raw = await readFile(getSessionPath(cwd, "append-1"), "utf8");
		const events = raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string });
		expect(events.map((event) => event.type)).toEqual([
			"session_start",
			"message",
			"message",
			"state",
		]);

		const index = await readFile(getSessionIndexPath(cwd), "utf8");
		expect(index).toContain('"sessionId":"append-1"');

		const restored = await loadSession(cwd, "append-1");
		expect(restored.messages).toEqual(nextState.messages);
		expect(restored.turn).toBe(1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("appendSessionMemoryExtraction records a lightweight background event", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state = createInitialState("hello", cwd, [], "memory-event-1");
		await appendSessionMemoryExtraction(cwd, state, {
			subAgentSessionId: "memory-event-1.memory.0",
			ok: true,
			summary: "NO_MEMORY",
		});

		const raw = await readFile(getSessionPath(cwd, "memory-event-1"), "utf8");
		const events = raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; summary?: string });

		expect(events.map((event) => event.type)).toEqual([
			"session_start",
			"memory_extraction",
		]);
		expect(events[1]?.summary).toBe("NO_MEMORY");

		const restored = await loadSession(cwd, "memory-event-1");
		expect(restored.messages).toEqual([]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("loadSession accepts legacy full AgentState files", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state = createInitialState("legacy", cwd, [], "legacy-1");
		await mkdir(join(cwd, ".cagent", "sessions"), { recursive: true });
		await writeFile(
			join(cwd, ".cagent", "sessions", "legacy-1.json"),
			`${JSON.stringify(
				{
					version: 1,
					id: "legacy-1",
					savedAt: "2026-07-09T00:00:00.000Z",
					state,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const restored = await loadSession(cwd, "legacy-1");
		expect(restored.sessionId).toBe("legacy-1");
		expect(restored.messages).toEqual(state.messages);
		expect(restored.toolSpecs.map((tool) => tool.name)).toContain("Read");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("session ids cannot escape the sessions directory", () => {
	expect(() => getSessionPath("/repo", "../outside")).toThrow(
		"invalid session id",
	);
});

test("parseCliArgs supports resume id and preserves task text", () => {
	expect(parseCliArgs(["--resume", "session-1", "continue", "work"])).toEqual({
		resumeId: "session-1",
		task: "continue work",
	});

	expect(parseCliArgs(["--resume=session-2"])).toEqual({
		resumeId: "session-2",
		task: undefined,
	});
});
