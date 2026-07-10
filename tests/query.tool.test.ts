import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ensureMemoryStore, getMemoryIndexPath } from "../src/memory";
import type {
	ModelClient,
	ModelRequest,
	ModelStreamEvent,
} from "../src/model/client";
import type { Terminal } from "../src/query";
import { query } from "../src/query";
import {
	appendSessionMessage,
	appendSessionState,
	ensureSessionStarted,
	getSessionPath,
} from "../src/sessionStore";
import { createInitialState, createToolPermissionContext } from "../src/state";
import type { Tool } from "../src/tools/types";
import { writeTool } from "../src/tools/writeTool";

const addTool: Tool<{ a: number; b: number }, { sum: number }> = {
	name: "add",
	description: "Add two numbers",
	inputSchema: z.object({ a: z.number(), b: z.number() }),
	async call({ a, b }) {
		return { sum: a + b };
	},
};

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cagent-query-"));
}

class FakeToolCallingModelClient implements ModelClient {
	readonly name = "fake";
	private callCount = 0;

	async *stream(_request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.callCount++;
		if (this.callCount === 1) {
			yield {
				type: "tool_call",
				id: "call_1",
				name: "add",
				arguments: JSON.stringify({ a: 2, b: 3 }),
			};
			return;
		}

		yield { type: "text_delta", content: "The sum is 5" };
	}
}

test("query executes a tool call and round-trips the result back to the model", async () => {
	const model = new FakeToolCallingModelClient();
	const initialState = createInitialState("add 2 and 3", "/repo");

	let terminal: Terminal | undefined;
	for await (const event of query({ initialState, model, tools: [addTool] })) {
		if (event.type === "terminal") {
			terminal = event.terminal;
		}
	}

	expect(terminal?.reason).toBe("complete");
	expect(terminal?.state.finalAnswer).toBe("The sum is 5");
	expect(terminal?.state.toolSpecs).toEqual([
		{
			name: "add",
			description: "Add two numbers",
			inputSchema: {
				$schema: "https://json-schema.org/draft/2020-12/schema",
				additionalProperties: false,
				properties: {
					a: { type: "number" },
					b: { type: "number" },
				},
				required: ["a", "b"],
				type: "object",
			},
		},
	]);

	const toolMessage = terminal?.state.messages.find((m) => m.role === "tool");
	expect(toolMessage?.toolCallId).toBe("call_1");
	expect(toolMessage?.content).toBe(JSON.stringify({ sum: 5 }));

	expect(terminal?.state.observations).toEqual([
		{
			tool: "add",
			args: { a: 2, b: 3 },
			ok: true,
			output: JSON.stringify({ sum: 5 }),
		},
	]);
	expect(terminal?.state.lastToolCall).toEqual({
		name: "add",
		args: { a: 2, b: 3 },
	});
});

test("query feeds an error back as the tool result when the tool is unknown", async () => {
	const model = new FakeToolCallingModelClient();
	const initialState = createInitialState("add 2 and 3", "/repo");

	let terminal: Terminal | undefined;
	for await (const event of query({ initialState, model, tools: [] })) {
		if (event.type === "terminal") {
			terminal = event.terminal;
		}
	}

	const toolMessage = terminal?.state.messages.find((m) => m.role === "tool");
	expect(toolMessage?.content).toBe("error: unknown tool: add");
	expect(terminal?.state.observations[0]?.ok).toBe(false);
});

class FakeInvalidArgsModelClient implements ModelClient {
	readonly name = "fake";
	private callCount = 0;

	async *stream(_request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.callCount++;
		if (this.callCount === 1) {
			yield {
				type: "tool_call",
				id: "call_1",
				name: "add",
				arguments: JSON.stringify({ a: 2 }), // missing required field `b`
			};
			return;
		}

		yield { type: "text_delta", content: "done" };
	}
}

class WritePathModelClient implements ModelClient {
	readonly name = "write-path";
	private callCount = 0;

	constructor(private readonly filePath: string) {}

	async *stream(_request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.callCount++;
		if (this.callCount === 1) {
			yield {
				type: "tool_call",
				id: "write",
				name: "Write",
				arguments: JSON.stringify({
					file_path: this.filePath,
					content: "written",
				}),
			};
			return;
		}

		yield { type: "text_delta", content: "done" };
	}
}

test("query rejects arguments that fail the tool input schema before calling it", async () => {
	let called = false;
	const trackedAddTool: Tool<{ a: number; b: number }, { sum: number }> = {
		...addTool,
		async call(input) {
			called = true;
			return addTool.call(input);
		},
	};

	const model = new FakeInvalidArgsModelClient();
	const initialState = createInitialState("add 2 and 3", "/repo");

	let terminal: Terminal | undefined;
	for await (const event of query({
		initialState,
		model,
		tools: [trackedAddTool],
	})) {
		if (event.type === "terminal") {
			terminal = event.terminal;
		}
	}

	expect(called).toBe(false);
	const toolMessage = terminal?.state.messages.find((m) => m.role === "tool");
	expect(toolMessage?.content).toMatch(/^error:/);
	expect(terminal?.state.observations[0]?.ok).toBe(false);
});

test("normal mode write policy allows configured paths", async () => {
	const cwd = await makeTempDir();
	try {
		const allowedPath = join(cwd, "allowed", "note.md");
		const initialState = {
			...createInitialState("write allowed", cwd),
			toolPermissionContext: createToolPermissionContext(cwd, {
				writePolicy: {
					allow: [join(cwd, "allowed")],
					deny: [join(cwd, "blocked")],
				},
			}),
		};
		const model = new WritePathModelClient(allowedPath);

		let terminal: Terminal | undefined;
		for await (const event of query({
			initialState,
			model,
			tools: [writeTool],
		})) {
			if (event.type === "terminal") {
				terminal = event.terminal;
			}
		}

		expect(terminal?.state.observations[0]?.ok).toBe(true);
		expect(await readFile(allowedPath, "utf8")).toBe("written");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("normal mode write policy denies configured paths", async () => {
	const cwd = await makeTempDir();
	try {
		const deniedPath = join(cwd, "blocked", "note.md");
		const initialState = {
			...createInitialState("write denied", cwd),
			toolPermissionContext: createToolPermissionContext(cwd, {
				writePolicy: {
					allow: [cwd],
					deny: [join(cwd, "blocked")],
				},
			}),
		};
		const model = new WritePathModelClient(deniedPath);

		let terminal: Terminal | undefined;
		for await (const event of query({
			initialState,
			model,
			tools: [writeTool],
		})) {
			if (event.type === "terminal") {
				terminal = event.terminal;
			}
		}

		expect(terminal?.state.observations[0]?.ok).toBe(false);
		expect(terminal?.state.observations[0]?.output).toContain(
			"denied by write policy",
		);
		await expect(access(deniedPath)).rejects.toThrow();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory agent write permissions are restricted to .cagent/memory", async () => {
	const cwd = await makeTempDir();
	try {
		const outsidePath = join(cwd, "outside.md");
		const initialState = {
			...createInitialState("write outside memory", cwd),
			toolPermissionContext: createToolPermissionContext(cwd, {
				agentType: "memory",
			}),
		};
		const model = new WritePathModelClient(outsidePath);

		let terminal: Terminal | undefined;
		for await (const event of query({
			initialState,
			model,
			tools: [writeTool],
		})) {
			if (event.type === "terminal") {
				terminal = event.terminal;
			}
		}

		expect(terminal?.state.observations[0]?.ok).toBe(false);
		expect(terminal?.state.observations[0]?.output).toContain(
			"Memory sub agent can only write files under .cagent/memory",
		);
		await expect(access(outsidePath)).rejects.toThrow();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("denied tool calls are persisted as session tool results", async () => {
	const cwd = await makeTempDir();
	try {
		const deniedPath = join(cwd, "blocked", "note.md");
		const initialState = {
			...createInitialState("persist denied write", cwd, [], "denied-log-1"),
			toolPermissionContext: createToolPermissionContext(cwd, {
				writePolicy: { deny: [join(cwd, "blocked")] },
			}),
		};
		const model = new WritePathModelClient(deniedPath);
		await ensureSessionStarted(cwd, initialState);

		let statePersisted = false;
		for await (const event of query({
			initialState,
			model,
			tools: [writeTool],
		})) {
			if (event.type === "message") {
				await appendSessionMessage(cwd, initialState, event.message);
			} else if (event.type === "state") {
				await appendSessionState(cwd, event.state);
				statePersisted = true;
			} else if (event.type === "terminal" && !statePersisted) {
				await appendSessionState(cwd, event.terminal.state);
			}
		}

		const raw = await readFile(getSessionPath(cwd, "denied-log-1"), "utf8");
		expect(raw).toContain('"type":"tool_result"');
		expect(raw).toContain("denied by write policy");
		await expect(access(deniedPath)).rejects.toThrow();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

class RecordingModelClient implements ModelClient {
	readonly name = "recording";
	readonly requests: ModelRequest[] = [];

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.requests.push(request);
		yield { type: "text_delta", content: "done" };
	}
}

class MemorySelectingModelClient implements ModelClient {
	readonly name = "memory-selecting";
	readonly requests: ModelRequest[] = [];

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.requests.push(request);
		if (request.messages[0]?.content.includes("select cagent memory files")) {
			yield {
				type: "text_delta",
				content: JSON.stringify({ selected_memories: ["preferences.md"] }),
			};
			return;
		}

		yield { type: "text_delta", content: "done" };
	}
}

test("query injects the memory prompt from the current memory index", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		await writeFile(
			getMemoryIndexPath(cwd),
			"# Memory\n\n- [Preferences](preferences.md) - prefers concise answers\n",
		);

		const model = new RecordingModelClient();
		const initialState = createInitialState("use memory", cwd);

		let terminal: Terminal | undefined;
		for await (const event of query({ initialState, model, tools: [] })) {
			if (event.type === "terminal") {
				terminal = event.terminal;
			}
		}

		const request = model.requests[0];
		expect(request?.messages[0]?.role).toBe("system");
		expect(request?.messages[0]?.content).toContain("# cagent memory");
		expect(request?.messages[0]?.content).toContain("prefers concise answers");
		expect(request?.messages.at(-1)).toEqual({
			role: "user",
			content: "use memory",
		});
		expect(terminal?.state.messages[0]).toEqual({
			role: "user",
			content: "use memory",
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("query uses a side query to inject relevant memory topic files", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		await writeFile(
			join(cwd, ".cagent", "memory", "preferences.md"),
			[
				"---",
				"type: feedback",
				"description: User prefers concise engineering answers",
				"---",
				"",
				"Keep final answers short and focus on concrete changes.",
			].join("\n"),
		);

		const model = new MemorySelectingModelClient();
		const initialState = createInitialState("how should you answer me?", cwd);

		let terminal: Terminal | undefined;
		for await (const event of query({ initialState, model, tools: [] })) {
			if (event.type === "terminal") {
				terminal = event.terminal;
			}
		}

		expect(terminal?.reason).toBe("complete");
		expect(model.requests).toHaveLength(2);
		expect(model.requests[0]?.messages[0]?.content).toContain(
			"select cagent memory files",
		);
		const mainRequest = model.requests[1];
		expect(
			mainRequest?.messages.some((message) =>
				message.content.includes("# relevant memories"),
			),
		).toBe(true);
		expect(
			mainRequest?.messages.some((message) =>
				message.content.includes("Keep final answers short"),
			),
		).toBe(true);
		expect(
			terminal?.state.messages.some((message) =>
				message.content.includes("Keep final answers short"),
			),
		).toBe(false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("query emits a memory extraction request after a tool-free complete turn", async () => {
	const cwd = await makeTempDir();
	try {
		const model = new RecordingModelClient();
		const initialState = createInitialState(
			"remember I prefer short answers",
			cwd,
		);
		const events: string[] = [];

		for await (const event of query({ initialState, model, tools: [] })) {
			events.push(event.type);
		}

		expect(events).toContain("memory_extraction_request");
		expect(events.at(-1)).toBe("terminal");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("query skips memory extraction request after tool use", async () => {
	const model = new FakeToolCallingModelClient();
	const initialState = createInitialState("add 2 and 3", "/repo");
	const events: string[] = [];

	for await (const event of query({ initialState, model, tools: [addTool] })) {
		events.push(event.type);
	}

	expect(events).not.toContain("memory_extraction_request");
});
