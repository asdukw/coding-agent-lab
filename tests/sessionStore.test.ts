import { expect, test } from "bun:test";
import {
	appendFile,
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
			changedFiles: ["src/auth.ts"],
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
		expect(restored.changedFiles).toEqual(["src/auth.ts"]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("loadSession ignores an incomplete final JSONL record", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state = createInitialState(
			"recover tail",
			cwd,
			[],
			"tail-recovery-1",
		);
		const path = await saveSession(cwd, state);
		await appendFile(path, '{"partial":"tail"', "utf8");

		const restored = await loadSession(cwd, state.sessionId);
		expect(restored.sessionId).toBe(state.sessionId);
		expect(restored.messages).toEqual(state.messages);

		await appendSessionMessage(cwd, state, {
			role: "assistant",
			content: "continued after recovery",
		});
		const healedRaw = await readFile(path, "utf8");
		expect(healedRaw).not.toContain('{"partial":"tail"');
		expect(
			(await loadSession(cwd, state.sessionId)).messages.at(-1)?.content,
		).toBe("continued after recovery");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("loadSession rejects malformed JSONL before the final record", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state = createInitialState("reject corruption", cwd, [], "corrupt-1");
		const path = await saveSession(cwd, state);
		const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
		lines.splice(1, 0, '{"version":2');
		await writeFile(path, `${lines.join("\n")}\n`, "utf8");

		await expect(loadSession(cwd, state.sessionId)).rejects.toThrow(
			"invalid session event at line 2",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("loadSession rejects a complete but invalid final JSONL record", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state = createInitialState(
			"reject semantic tail",
			cwd,
			[],
			"semantic-tail-1",
		);
		const path = await saveSession(cwd, state);
		await appendFile(
			path,
			JSON.stringify({
				version: 2,
				timestamp: "2026-07-20T00:00:00.000Z",
				type: "future_event",
				sessionId: state.sessionId,
				payload: {},
			}),
			"utf8",
		);

		await expect(loadSession(cwd, state.sessionId)).rejects.toThrow(
			"unsupported session event type: future_event",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("loadSession rejects semantically invalid complete JSONL records", async () => {
	const scenarios: Array<{
		name: string;
		expected: string;
		createEvent(
			sessionId: string,
			timestamp: string,
			snapshot: Record<string, unknown>,
		): Record<string, unknown>;
	}> = [
		{
			name: "unknown version",
			expected: "unsupported session event version: 3",
			createEvent: (sessionId, timestamp) => ({
				version: 3,
				timestamp,
				type: "future_event",
				sessionId,
				payload: {},
			}),
		},
		{
			name: "unknown type",
			expected: "unsupported session event type: future_event",
			createEvent: (sessionId, timestamp) => ({
				version: 2,
				timestamp,
				type: "future_event",
				sessionId,
				payload: {},
			}),
		},
		{
			name: "missing payload",
			expected: "session event.payload is required",
			createEvent: (sessionId, timestamp) => ({
				version: 2,
				timestamp,
				type: "user_message",
				sessionId,
			}),
		},
		{
			name: "missing session id",
			expected: "session event.sessionId is required",
			createEvent: (_sessionId, timestamp) => ({
				version: 2,
				timestamp,
				type: "user_message",
				payload: { message: { role: "user", content: "tampered" } },
			}),
		},
		{
			name: "message role mismatch",
			expected: "user_message payload has incompatible message role",
			createEvent: (sessionId, timestamp) => ({
				version: 2,
				timestamp,
				type: "user_message",
				sessionId,
				payload: {
					message: { role: "assistant", content: "tampered" },
				},
			}),
		},
		{
			name: "invalid snapshot payload",
			expected: "state_snapshot payload budget.turnsUsed",
			createEvent: (_sessionId, _timestamp, snapshot) => ({
				...snapshot,
				payload: {
					...(snapshot.payload as Record<string, unknown>),
					budget: { turnsUsed: "tampered", maxTurns: 20 },
				},
			}),
		},
		{
			name: "invalid permission mode",
			expected: "state_snapshot payload toolPermissionContext.mode is invalid",
			createEvent: (_sessionId, _timestamp, snapshot) => {
				const snapshotPayload = snapshot.payload as Record<string, unknown>;
				return {
					...snapshot,
					payload: {
						...snapshotPayload,
						toolPermissionContext: {
							...(snapshotPayload.toolPermissionContext as Record<
								string,
								unknown
							>),
							mode: "bypass",
						},
					},
				};
			},
		},
	];

	for (const [index, scenario] of scenarios.entries()) {
		const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
		try {
			const sessionId = `semantic-corruption-${index}`;
			const state = createInitialState(scenario.name, cwd, [], sessionId);
			const path = await saveSession(cwd, state);
			const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
			const snapshot = JSON.parse(lines.at(-1) ?? "null") as Record<
				string,
				unknown
			>;
			lines.splice(
				1,
				0,
				JSON.stringify(
					scenario.createEvent(sessionId, "2026-07-20T00:00:00.000Z", snapshot),
				),
			);
			await writeFile(path, `${lines.join("\n")}\n`, "utf8");

			await expect(loadSession(cwd, sessionId)).rejects.toThrow(
				`invalid session event at line 2: ${scenario.expected}`,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}
});

test("loadSession rejects blank records and duplicate metadata", async () => {
	for (const corruption of ["blank", "duplicate metadata"] as const) {
		const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
		try {
			const sessionId = `sequence-corruption-${corruption.replace(" ", "-")}`;
			const state = createInitialState(corruption, cwd, [], sessionId);
			const path = await saveSession(cwd, state);
			const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
			lines.splice(1, 0, corruption === "blank" ? "" : (lines[0] ?? ""));
			await writeFile(path, `${lines.join("\n")}\n`, "utf8");

			await expect(loadSession(cwd, sessionId)).rejects.toThrow(
				corruption === "blank"
					? "invalid session event at line 2: empty records are not allowed"
					: "invalid session event at line 2: duplicate session metadata",
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}
});

test("loadSession requires metadata as the first complete event", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state = createInitialState(
			"metadata first",
			cwd,
			[],
			"metadata-first-1",
		);
		const path = await saveSession(cwd, state);
		const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
		const metadata = JSON.parse(lines[0] ?? "null") as Record<string, unknown>;
		lines[0] = JSON.stringify({
			...metadata,
			type: "user_message",
			payload: { message: { role: "user", content: "tampered" } },
		});
		await writeFile(path, `${lines.join("\n")}\n`, "utf8");

		await expect(loadSession(cwd, state.sessionId)).rejects.toThrow(
			"invalid session event at line 1: first event must contain session metadata",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("concurrent message appends keep each event batch contiguous", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state = createInitialState(
			"append concurrently",
			cwd,
			[],
			"concurrent-1",
		);
		const messages = Array.from({ length: 20 }, (_, index) => ({
			role: "assistant" as const,
			content: `message-${index}`,
			toolCalls: [
				{
					id: `call-${index}`,
					name: "Read",
					arguments: JSON.stringify({ file_path: `file-${index}.txt` }),
				},
			],
		}));

		await Promise.all(
			messages.map((message) => appendSessionMessage(cwd, state, message)),
		);

		const events = (
			await readFile(getSessionPath(cwd, state.sessionId), "utf8")
		)
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						type: string;
						payload?: {
							id?: string;
							message?: { toolCalls?: Array<{ id: string }> };
						};
					},
			);
		expect(events[0]?.type).toBe("session_meta");
		expect(events).toHaveLength(1 + messages.length * 2);
		for (let index = 1; index < events.length; index += 2) {
			const messageEvent = events[index];
			const toolCallEvent = events[index + 1];
			expect(messageEvent?.type).toBe("assistant_message");
			expect(toolCallEvent?.type).toBe("tool_call");
			expect(toolCallEvent?.payload?.id).toBe(
				messageEvent?.payload?.message?.toolCalls?.[0]?.id,
			);
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("concurrent saves serialize complete session files and index entries", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const states = Array.from({ length: 16 }, (_, index) =>
			createInitialState(
				`concurrent save ${index}`,
				cwd,
				[],
				`concurrent-save-${index}`,
			),
		);

		await Promise.all(states.map((state) => saveSession(cwd, state)));

		const indexEntries = (await readFile(getSessionIndexPath(cwd), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { sessionId: string });
		expect(indexEntries).toHaveLength(states.length);
		expect(new Set(indexEntries.map((entry) => entry.sessionId))).toEqual(
			new Set(states.map((state) => state.sessionId)),
		);

		for (const state of states) {
			const raw = await readFile(getSessionPath(cwd, state.sessionId), "utf8");
			expect(raw.endsWith("\n")).toBe(true);
			for (const line of raw.trim().split("\n")) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
		}

		const files = await readdir(join(cwd, ".cagent", "sessions"));
		expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("concurrent saves to one session leave one complete snapshot", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const states = Array.from({ length: 12 }, (_, index) => ({
			...createInitialState(
				`same session ${index}`,
				cwd,
				[],
				"same-session-save",
			),
			turn: index,
		}));

		await Promise.all(states.map((state) => saveSession(cwd, state)));

		const events = (
			await readFile(getSessionPath(cwd, "same-session-save"), "utf8")
		)
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						type: string;
						payload?: { task?: string; turn?: number };
					},
			);
		expect(events[0]?.type).toBe("session_meta");
		expect(events.at(-1)?.type).toBe("state_snapshot");
		expect(events[0]?.payload?.task).toBe(events.at(-1)?.payload?.task);
		const savedTask = events[0]?.payload?.task;
		const savedTurn = events.at(-1)?.payload?.turn;
		if (savedTask === undefined || savedTurn === undefined) {
			throw new Error("expected a complete session snapshot");
		}
		const restored = await loadSession(cwd, "same-session-save");
		expect(restored.task).toBe(savedTask);
		expect(restored.turn).toBe(savedTurn);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("a later index append removes an incomplete index tail", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const first = createInitialState("first", cwd, [], "index-tail-1");
		const second = createInitialState("second", cwd, [], "index-tail-2");
		await saveSession(cwd, first);
		const indexPath = getSessionIndexPath(cwd);
		await appendFile(indexPath, '{"partial":"index"', "utf8");

		await saveSession(cwd, second);

		const raw = await readFile(indexPath, "utf8");
		expect(raw).not.toContain('{"partial":"index"');
		expect(
			raw
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { sessionId: string }).sessionId),
		).toEqual([first.sessionId, second.sessionId]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("a failed atomic replace cleans up its temporary file", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state = createInitialState(
			"replace failure",
			cwd,
			[],
			"replace-failure-1",
		);
		await mkdir(getSessionPath(cwd, state.sessionId), { recursive: true });

		await expect(saveSession(cwd, state)).rejects.toThrow();

		const files = await readdir(join(cwd, ".cagent", "sessions"));
		expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("a failed snapshot serialization preserves the previous session", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state = createInitialState(
			"stable snapshot",
			cwd,
			[],
			"atomic-failure-1",
		);
		const path = await saveSession(cwd, state);
		const previous = await readFile(path, "utf8");
		const circularMessage = {
			role: "assistant" as const,
			content: "cannot serialize",
			cycle: undefined as unknown,
		};
		circularMessage.cycle = circularMessage;

		await expect(
			saveSession(cwd, {
				...state,
				messages: [...state.messages, circularMessage],
			}),
		).rejects.toThrow();
		expect(await readFile(path, "utf8")).toBe(previous);

		await appendSessionMessage(cwd, state, {
			role: "assistant",
			content: "queue recovered",
		});
		const restored = await loadSession(cwd, state.sessionId);
		expect(restored.messages.at(-1)?.content).toBe("queue recovered");
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

test("agent coordination messages persist without becoming user events", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state = createInitialState("hello", cwd, [], "agent-message-1");
		const message = {
			role: "agent" as const,
			content: '[agent-coordination:untrusted]\n{"summary":"done"}',
		};
		await appendSessionMessage(cwd, state, message);
		await appendSessionState(cwd, {
			...state,
			messages: [...state.messages, message],
			changedFiles: ["src/agent-change.ts"],
		});

		const raw = await readFile(getSessionPath(cwd, "agent-message-1"), "utf8");
		expect(raw).toContain('"type":"agent_message"');
		const restored = await loadSession(cwd, "agent-message-1");
		expect(restored.messages.at(-1)).toEqual({
			...message,
			containsUntrustedAgentContent: true,
		});
		expect(restored.changedFiles).toEqual(["src/agent-change.ts"]);
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
		expect(restored.messages).toEqual([
			{
				role: "agent",
				content:
					"[restored-session:untrusted-system-message]\n## Auto-compacted conversation summary\n\nfirst task",
				containsUntrustedAgentContent: true,
			},
			{ role: "user", content: "continue with the current task" },
		]);
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

	expect(parseCliArgs(["--help"])).toEqual({
		help: true,
		resumeId: undefined,
		task: undefined,
	});
	expect(parseCliArgs(["-V"])).toEqual({
		resumeId: undefined,
		task: undefined,
		version: true,
	});
	expect(parseCliArgs(["--", "--resume", "literal-task"])).toEqual({
		resumeId: undefined,
		task: "--resume literal-task",
	});
});
