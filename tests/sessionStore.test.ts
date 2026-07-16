import { expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../src/main";
import {
	appendSessionCompaction,
	appendSessionMemoryExtraction,
	appendSessionMessage,
	appendSessionState,
	ensureSessionStarted,
	getMemoryExtractionAuditDir,
	getSessionIndexPath,
	getSessionPath,
	loadSession,
	persistSessionMemoryExtraction,
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
		expect(raw).toContain('"version":2');
		expect(raw).toContain('"sessionId":"session-1"');
		expect(raw).toContain('"timestamp"');
		expect(raw).toContain('"payload"');
		expect(raw).not.toContain('"toolSpecs"');
		expect(raw).not.toContain('"inputSchema"');
		expect(raw).not.toContain('"finalAnswer"');
		expect(raw).not.toContain('"observations"');
		const events = raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string });
		expect(events.map((event) => event.type)).toEqual([
			"session_meta",
			"user_message",
			"assistant_message",
			"state_snapshot",
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
			"session_meta",
			"user_message",
			"assistant_message",
			"state_snapshot",
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
			.map(
				(line) =>
					JSON.parse(line) as {
						type: string;
						payload?: { summary?: string };
					},
			);

		expect(events.map((event) => event.type)).toEqual([
			"session_meta",
			"memory_extraction",
		]);
		expect(events[1]?.payload?.summary).toBe("NO_MEMORY");

		const restored = await loadSession(cwd, "memory-event-1");
		expect(restored.messages).toEqual([]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("context compaction replaces restored session history", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state = createInitialState("first", cwd, [], "compact-session-1");
		await ensureSessionStarted(cwd, state);
		for (const message of state.messages) {
			await appendSessionMessage(cwd, state, message);
		}

		const compacted: AgentState = {
			...state,
			messages: [
				{
					role: "system",
					content: "## Auto-compacted conversation summary\n\nfirst task",
				},
				{ role: "user", content: "continue with the current task" },
			],
		};
		await appendSessionCompaction(cwd, compacted);

		const restored = await loadSession(cwd, state.sessionId);
		expect(restored.messages).toEqual(compacted.messages);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory extraction audit falls back when the session event cannot be written", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state = createInitialState("hello", cwd, [], "memory-fallback-1");
		await mkdir(getSessionPath(cwd, state.sessionId), { recursive: true });

		await persistSessionMemoryExtraction(cwd, state, {
			subAgentSessionId: "memory-fallback-1.memory.0",
			ok: false,
			reason: "tool_error",
			summary: "write denied",
		});

		const auditDir = getMemoryExtractionAuditDir(cwd);
		const auditFiles = await readdir(auditDir);
		expect(auditFiles).toHaveLength(1);
		const raw = await readFile(
			join(auditDir, auditFiles[0] ?? "missing"),
			"utf8",
		);
		expect(raw).toContain('"type":"memory_extraction_persistence_fallback"');
		expect(raw).toContain('"reason":"tool_error"');
		expect(raw).toContain('"summary":"write denied"');
		expect(raw).toContain('"persistenceError"');
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory extraction audit fallback rejects a symlinked audit directory", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state = createInitialState("hello", cwd, [], "memory-fallback-link");
		await mkdir(getSessionPath(cwd, state.sessionId), { recursive: true });
		const outsideDir = join(cwd, "outside-audit");
		await mkdir(outsideDir, { recursive: true });
		await mkdir(join(cwd, ".cagent", "audit"), { recursive: true });
		await symlink(
			outsideDir,
			getMemoryExtractionAuditDir(cwd),
			process.platform === "win32" ? "junction" : "dir",
		);

		await expect(
			persistSessionMemoryExtraction(cwd, state, {
				subAgentSessionId: "memory-fallback-link.memory.0",
				ok: false,
				reason: "tool_error",
				summary: "write denied",
			}),
		).rejects.toThrow("memory extraction audit persistence failed");
		expect(await readdir(outsideDir)).toEqual([]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("assistant tool calls are stored as separate audit events", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const message = {
			role: "assistant" as const,
			content: "",
			toolCalls: [
				{
					id: "call-1",
					name: "Read",
					arguments: JSON.stringify({ file_path: "README.md" }),
				},
			],
		};
		const toolResult = {
			role: "tool" as const,
			content: JSON.stringify({ content: "file contents" }),
			toolCallId: "call-1",
		};
		const state: AgentState = {
			...createInitialState("inspect", cwd, [], "tool-call-1"),
			messages: [{ role: "user", content: "inspect" }, message, toolResult],
		};

		await saveSession(cwd, state);
		const raw = await readFile(getSessionPath(cwd, "tool-call-1"), "utf8");
		const events = raw
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						type: string;
						payload?: { name?: string; message?: unknown };
					},
			);

		expect(events.map((event) => event.type)).toEqual([
			"session_meta",
			"user_message",
			"assistant_message",
			"tool_call",
			"tool_result",
			"state_snapshot",
		]);
		expect(events[3]?.payload?.name).toBe("Read");

		const restored = await loadSession(cwd, "tool-call-1");
		expect(restored.messages).toEqual(state.messages);
		expect(restored.toolExecutions).toEqual([
			expect.objectContaining({
				callId: "call-1",
				tool: "Read",
				status: "succeeded",
				target: "file_path=README.md",
			}),
		]);
		expect(restored.toolExecutions[0]).not.toHaveProperty("output");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("loadSession accepts legacy JSONL session events", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		await mkdir(join(cwd, ".cagent", "sessions"), { recursive: true });
		await writeFile(
			join(cwd, ".cagent", "sessions", "legacy-jsonl-1.jsonl"),
			`${[
				{
					type: "session_start",
					version: 1,
					sessionId: "legacy-jsonl-1",
					cwd,
					task: "legacy jsonl",
					createdAt: "2026-07-09T00:00:00.000Z",
				},
				{
					type: "message",
					sessionId: "legacy-jsonl-1",
					message: { role: "user", content: "legacy jsonl" },
					createdAt: "2026-07-09T00:00:00.000Z",
				},
				{
					type: "state",
					sessionId: "legacy-jsonl-1",
					task: "legacy jsonl",
					toolPermissionContext: { mode: "normal" },
					plan: { items: [] },
					turn: 1,
					budget: { turnsUsed: 1, maxTurns: 20 },
					savedAt: "2026-07-09T00:00:00.000Z",
				},
			]
				.map((event) => JSON.stringify(event))
				.join("\n")}\n`,
			"utf8",
		);

		const restored = await loadSession(cwd, "legacy-jsonl-1");
		expect(restored.sessionId).toBe("legacy-jsonl-1");
		expect(restored.messages).toEqual([
			{ role: "user", content: "legacy jsonl" },
		]);
		expect(restored.turn).toBe(1);
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
