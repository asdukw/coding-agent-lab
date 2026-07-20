import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
	ModelClient,
	ModelRequest,
	ModelStreamEvent,
} from "../src/model/client";
import { query, type Terminal } from "../src/query";
import { loadSession, saveSession } from "../src/sessionStore";
import {
	continueState,
	createInitialState,
	resolveToolApproval,
} from "../src/state";
import { toolArgumentFingerprint } from "../src/tools/permissions";
import type { Tool } from "../src/tools/types";

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cagent-permission-"));
}

const writeInput = z.object({ file_path: z.string(), content: z.string() });

function trackedWriteTool(counter: { calls: number }): Tool {
	return {
		name: "Write",
		description: "Tracked workspace write",
		inputSchema: writeInput,
		async call() {
			counter.calls++;
			return { bytesWritten: 1 };
		},
	};
}

function trackedProbeTool(counter: { calls: number }): Tool {
	return {
		name: "Probe",
		description: "Tracked safe operation",
		inputSchema: z.object({}),
		async call() {
			counter.calls++;
			return { ok: true };
		},
	};
}

class BatchModel implements ModelClient {
	readonly name = "batch-permission";
	readonly requests: ModelRequest[] = [];
	private callCount = 0;

	constructor(private readonly filePath: string) {}

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.requests.push(request);
		this.callCount++;
		if (this.callCount === 1) {
			yield { type: "tool_call", id: "safe", name: "Probe", arguments: "{}" };
			yield {
				type: "tool_call",
				id: "write",
				name: "Write",
				arguments: JSON.stringify({
					file_path: this.filePath,
					content: "approved",
				}),
			};
			return;
		}
		yield { type: "text_delta", content: "finished" };
	}
}

async function drainQuery(
	params: Parameters<typeof query>[0],
): Promise<Terminal> {
	let terminal: Terminal | undefined;
	for await (const event of query(params)) {
		if (event.type === "terminal") {
			terminal = event.terminal;
		}
	}
	if (!terminal) {
		throw new Error("query did not terminate");
	}
	return terminal;
}

test("an approval pauses the whole tool batch before any call executes", async () => {
	const cwd = await makeTempDir();
	try {
		const writeCounter = { calls: 0 };
		const probeCounter = { calls: 0 };
		const tools = [
			trackedProbeTool(probeCounter),
			trackedWriteTool(writeCounter),
		];
		const model = new BatchModel(join(cwd, "approved.txt"));
		const paused = await drainQuery({
			initialState: createInitialState("run a mixed batch", cwd),
			model,
			tools,
		});

		expect(paused.reason).toBe("tool_approval");
		expect(
			paused.state.toolPermissionContext.pendingToolApproval?.requests,
		).toHaveLength(1);
		expect(probeCounter.calls).toBe(0);
		expect(writeCounter.calls).toBe(0);

		const completed = await drainQuery({
			initialState: resolveToolApproval(paused.state, "allow_once"),
			model,
			tools,
		});
		expect(completed.reason).toBe("complete");
		expect(probeCounter.calls).toBe(1);
		expect(writeCounter.calls).toBe(1);
		expect(
			completed.state.messages
				.filter((message) => message.role === "tool")
				.map((message) => message.toolCallId),
		).toEqual(["safe", "write"]);
		expect(
			completed.state.toolPermissionContext.pendingToolApproval,
		).toBeUndefined();
		expect(completed.state.toolPermissionContext.sessionAllowedTools).toEqual(
			[],
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("denial returns a tool error without calling the denied tool", async () => {
	const cwd = await makeTempDir();
	try {
		const writeCounter = { calls: 0 };
		const model = new BatchModel(join(cwd, "denied.txt"));
		const tools = [
			trackedProbeTool({ calls: 0 }),
			trackedWriteTool(writeCounter),
		];
		const paused = await drainQuery({
			initialState: createInitialState("deny the write", cwd),
			model,
			tools,
		});
		const completed = await drainQuery({
			initialState: resolveToolApproval(paused.state, "deny"),
			model,
			tools,
		});

		expect(completed.reason).toBe("complete");
		expect(writeCounter.calls).toBe(0);
		const denied = completed.state.messages.find(
			(message) => message.role === "tool" && message.toolCallId === "write",
		);
		expect(denied?.content).toContain("User denied Write");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

class RepeatedWriteModel implements ModelClient {
	readonly name = "repeated-write";
	private callCount = 0;

	constructor(private readonly filePath: string) {}

	async *stream(_request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.callCount++;
		if (this.callCount === 1 || this.callCount === 3) {
			yield {
				type: "tool_call",
				// Call IDs are only request-scoped; later turns may legitimately reuse one.
				id: "write",
				name: "Write",
				arguments: JSON.stringify({
					file_path: this.filePath,
					content: `content-${this.callCount}`,
				}),
			};
			return;
		}
		yield { type: "text_delta", content: "done" };
	}
}

test("allow_session permits later calls to the same tool but hard boundaries remain", async () => {
	const cwd = await makeTempDir();
	try {
		const counter = { calls: 0 };
		const tool = trackedWriteTool(counter);
		const model = new RepeatedWriteModel(join(cwd, "session.txt"));
		const paused = await drainQuery({
			initialState: createInitialState("first write", cwd),
			model,
			tools: [tool],
		});
		const first = await drainQuery({
			initialState: resolveToolApproval(paused.state, "allow_session"),
			model,
			tools: [tool],
		});
		const second = await drainQuery({
			initialState: continueState(first.state, "second write"),
			model,
			tools: [tool],
		});

		expect(first.reason).toBe("complete");
		expect(second.reason).toBe("complete");
		expect(counter.calls).toBe(2);
		expect(second.state.toolPermissionContext.sessionAllowedTools).toContain(
			"Write",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("protected .env writes are denied without presenting an approval", async () => {
	const cwd = await makeTempDir();
	try {
		const counter = { calls: 0 };
		const model = new RepeatedWriteModel(join(cwd, ".env.local"));
		const terminal = await drainQuery({
			initialState: createInitialState("write a secret file", cwd),
			model,
			tools: [trackedWriteTool(counter)],
		});

		expect(terminal.reason).toBe("complete");
		expect(counter.calls).toBe(0);
		expect(
			terminal.state.messages.find((message) => message.role === "tool")
				?.content,
		).toContain("protected path");
		expect(
			terminal.state.toolPermissionContext.pendingToolApproval,
		).toBeUndefined();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("project instructions are injected as system context but not persisted", async () => {
	const cwd = await makeTempDir();
	try {
		await writeFile(
			join(cwd, "AGENTS.md"),
			"Use the repository-specific rule.",
		);
		const requests: ModelRequest[] = [];
		const model: ModelClient = {
			name: "context-recording",
			async *stream(request) {
				requests.push(request);
				yield { type: "text_delta", content: "done" };
			},
		};
		const terminal = await drainQuery({
			initialState: createInitialState("inspect context", cwd),
			model,
			tools: [],
		});

		expect(
			requests[0]?.messages.some(
				(message) =>
					message.role === "system" &&
					message.content.includes("Use the repository-specific rule."),
			),
		).toBe(true);
		expect(
			terminal.state.messages.some((message) =>
				message.content.includes("Use the repository-specific rule."),
			),
		).toBe(false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("session-wide grants are reset when a writable session file is restored", async () => {
	const cwd = await makeTempDir();
	try {
		const state = createInitialState("persist safely", cwd, [], "grant-reset");
		state.toolPermissionContext.sessionAllowedTools = ["Write", "Shell"];
		await saveSession(cwd, state);

		const restored = await loadSession(cwd, state.sessionId);
		expect(restored.toolPermissionContext.sessionAllowedTools).toEqual([]);
		expect(restored.toolPermissionContext.writePolicy?.allow).toEqual([cwd]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("session restore keeps cwd and permission authority bound to the trusted workspace", async () => {
	const cwd = await makeTempDir();
	const outside = await makeTempDir();
	try {
		const state = createInitialState(
			"tampered authority",
			cwd,
			[],
			"bound-root",
		);
		await saveSession(cwd, {
			...state,
			cwd: outside,
			toolPermissionContext: {
				...state.toolPermissionContext,
				agentType: "memory",
				writePolicy: { allow: [outside] },
				sessionAllowedTools: ["Write"],
			},
		});

		const restored = await loadSession(cwd, state.sessionId);
		expect(restored.cwd).toBe(cwd);
		expect(restored.agent.type).toBe("main");
		expect(restored.toolPermissionContext.mode).toBe("normal");
		expect(restored.toolPermissionContext.agentType).toBe("main");
		expect(restored.toolPermissionContext.writePolicy?.allow).toEqual([cwd]);
		expect(restored.toolPermissionContext.sessionAllowedTools).toEqual([]);
	} finally {
		await Promise.all([
			rm(cwd, { recursive: true, force: true }),
			rm(outside, { recursive: true, force: true }),
		]);
	}
});

test("restored approval cannot hide another call behind an always grant", async () => {
	const cwd = await makeTempDir();
	try {
		const benignArgs = { command: "Write-Output benign" };
		const calls = [
			{
				id: "benign-shell",
				name: "Shell",
				arguments: JSON.stringify(benignArgs),
			},
			{
				id: "hidden-shell",
				name: "Shell",
				arguments: JSON.stringify({ command: "Write-Output hidden" }),
			},
		];
		const state = createInitialState(
			"restore approval",
			cwd,
			[],
			"hidden-call",
		);
		state.messages.push({ role: "assistant", content: "", toolCalls: calls });
		state.toolPermissionContext.pendingToolApproval = {
			calls,
			requests: [
				{
					callId: "benign-shell",
					toolName: "Shell",
					args: benignArgs,
					argumentFingerprint: toolArgumentFingerprint(benignArgs),
					reason: "executes a command",
				},
			],
		};
		await saveSession(cwd, state);

		const restored = await loadSession(cwd, state.sessionId);
		const executed: string[] = [];
		const shellTool: Tool = {
			name: "Shell",
			description: "Tracked shell",
			inputSchema: z.object({ command: z.string() }),
			async call(input) {
				executed.push((input as { command: string }).command);
				return { ok: true };
			},
		};
		const model: ModelClient = {
			name: "after-restored-approval",
			async *stream() {
				yield { type: "text_delta", content: "done" };
			},
		};
		const refreshed = await drainQuery({
			initialState: resolveToolApproval(restored, "allow_session"),
			model,
			tools: [shellTool],
		});

		expect(refreshed.reason).toBe("tool_approval");
		expect(executed).toEqual([]);
		expect(
			refreshed.state.toolPermissionContext.pendingToolApproval?.requests,
		).toHaveLength(2);
		expect(
			refreshed.state.toolPermissionContext.pendingToolApproval?.requests.map(
				(request) => request.callId,
			),
		).toEqual(["benign-shell", "hidden-shell"]);
		expect(refreshed.state.toolPermissionContext.sessionAllowedTools).toEqual(
			[],
		);

		const completed = await drainQuery({
			initialState: resolveToolApproval(refreshed.state, "deny"),
			model,
			tools: [shellTool],
		});
		expect(completed.reason).toBe("complete");
		expect(executed).toEqual([]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
