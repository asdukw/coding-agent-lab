import { expect, test } from "bun:test";
import {
	access,
	link,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	ensureMemoryStore,
	getMemoryDir,
	getMemoryIndexPath,
} from "../src/memory";
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

function createWriteApprovedState(task: string, cwd: string) {
	return {
		...createInitialState(task, cwd),
		toolPermissionContext: createToolPermissionContext(cwd, {
			sessionAllowedTools: ["Write"],
		}),
	};
}

class FakeToolCallingModelClient implements ModelClient {
	readonly name = "fake";
	readonly requests: ModelRequest[] = [];
	private callCount = 0;

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.requests.push(request);
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
	expect(terminal?.state.toolExecutions).toEqual([
		expect.objectContaining({
			callId: "call_1",
			tool: "add",
			status: "succeeded",
			turn: 1,
		}),
	]);
	expect(terminal?.state.toolExecutions[0]).not.toHaveProperty("output");
	expect(
		model.requests[1]?.messages.some((message) =>
			message.content.includes("# Session tool execution history"),
		),
	).toBe(false);
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
	expect(terminal?.state.toolExecutions[0]?.status).toBe("failed");
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

	constructor(
		private readonly filePath: string,
		private readonly content = "written",
	) {}

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		if (request.messages[0]?.content.includes("select cagent memory files")) {
			yield {
				type: "text_delta",
				content: JSON.stringify({ selected_memories: [] }),
			};
			return;
		}
		this.callCount++;
		if (this.callCount === 1) {
			yield {
				type: "tool_call",
				id: "write",
				name: "Write",
				arguments: JSON.stringify({
					file_path: this.filePath,
					content: this.content,
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
				sessionAllowedTools: ["Write"],
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

test("an unsafe memory directory does not block unrelated normal writes", async () => {
	const cwd = await makeTempDir();
	try {
		const outsideMemory = join(cwd, "outside-memory");
		await mkdir(join(cwd, ".cagent"), { recursive: true });
		await mkdir(outsideMemory, { recursive: true });
		await symlink(
			outsideMemory,
			getMemoryDir(cwd),
			process.platform === "win32" ? "junction" : "dir",
		);
		const normalPath = join(cwd, "normal.txt");
		let terminal: Terminal | undefined;
		for await (const event of query({
			initialState: createWriteApprovedState("write normal file", cwd),
			model: new WritePathModelClient(normalPath, "normal content"),
			tools: [writeTool],
		})) {
			if (event.type === "terminal") {
				terminal = event.terminal;
			}
		}

		expect(terminal?.state.observations[0]?.ok).toBe(true);
		expect(await readFile(normalPath, "utf8")).toBe("normal content");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("write policy applies to a directory alias final memory target", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		const aliasPath = join(cwd, "memory-policy-alias");
		await symlink(
			getMemoryDir(cwd),
			aliasPath,
			process.platform === "win32" ? "junction" : "dir",
		);
		const targetPath = join(aliasPath, "policy.md");
		const content = [
			"---",
			"type: project",
			"description: Policy protected memory",
			"created_at: 2026-07-10T00:00:00.000Z",
			"updated_at: 2026-07-10T00:00:00.000Z",
			"source: user",
			"confidence: high",
			"stability: evolving",
			"---",
			"",
			"Must remain denied.",
		].join("\n");
		const initialState = {
			...createInitialState("write through memory alias", cwd),
			toolPermissionContext: createToolPermissionContext(cwd, {
				writePolicy: {
					allow: [cwd],
					deny: [getMemoryDir(cwd)],
				},
			}),
		};
		let terminal: Terminal | undefined;
		for await (const event of query({
			initialState,
			model: new WritePathModelClient(targetPath, content),
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
		await expect(
			access(join(getMemoryDir(cwd), "policy.md")),
		).rejects.toThrow();
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

test("authorized relative write paths are normalized against the agent cwd", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		let receivedPath = "";
		const capturingWriteTool: Tool<
			{ file_path: string; content: string },
			{ bytesWritten: number }
		> = {
			...writeTool,
			async call({ file_path, content }) {
				receivedPath = file_path;
				return { bytesWritten: Buffer.byteLength(content) };
			},
		};
		const initialState = {
			...createInitialState("write relative memory", cwd),
			toolPermissionContext: createToolPermissionContext(cwd, {
				agentType: "memory",
			}),
		};
		for await (const _event of query({
			initialState,
			model: new WritePathModelClient(".cagent/memory/relative.md"),
			tools: [capturingWriteTool],
		})) {
			// Drain the query.
		}

		expect(receivedPath).toBe(join(cwd, ".cagent", "memory", "relative.md"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("main agent writes inside memory use the strict memory validator", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		const invalidPath = join(cwd, ".cagent", "memory", "invalid.md");
		let terminal: Terminal | undefined;
		for await (const event of query({
			initialState: createWriteApprovedState("write invalid memory", cwd),
			model: new WritePathModelClient(invalidPath),
			tools: [writeTool],
		})) {
			if (event.type === "terminal") {
				terminal = event.terminal;
			}
		}

		expect(terminal?.state.observations[0]?.ok).toBe(false);
		expect(terminal?.state.observations[0]?.output).toContain(
			"Invalid memory file",
		);
		await expect(access(invalidPath)).rejects.toThrow();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("main agent cannot bypass memory validation through a directory alias", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		const aliasPath = join(cwd, "memory-alias");
		await symlink(
			getMemoryDir(cwd),
			aliasPath,
			process.platform === "win32" ? "junction" : "dir",
		);
		const invalidPath = join(aliasPath, "invalid.md");
		let terminal: Terminal | undefined;
		for await (const event of query({
			initialState: createWriteApprovedState(
				"write invalid aliased memory",
				cwd,
			),
			model: new WritePathModelClient(invalidPath),
			tools: [writeTool],
		})) {
			if (event.type === "terminal") {
				terminal = event.terminal;
			}
		}

		expect(terminal?.state.observations[0]?.ok).toBe(false);
		expect(terminal?.state.observations[0]?.output).toContain(
			"Invalid memory file",
		);
		await expect(
			access(join(getMemoryDir(cwd), "invalid.md")),
		).rejects.toThrow();

		const originalIndex = await readFile(getMemoryIndexPath(cwd), "utf8");
		terminal = undefined;
		for await (const event of query({
			initialState: createWriteApprovedState(
				"overwrite aliased memory index",
				cwd,
			),
			model: new WritePathModelClient(join(aliasPath, "memory.md")),
			tools: [writeTool],
		})) {
			if (event.type === "terminal") {
				terminal = event.terminal;
			}
		}

		expect(terminal?.state.observations[0]?.ok).toBe(false);
		expect(terminal?.state.observations[0]?.output).toContain(
			"MEMORY.md is managed automatically",
		);
		expect(await readFile(getMemoryIndexPath(cwd), "utf8")).toBe(originalIndex);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("main agent rejects outside hardlinks to memory files", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		const topicPath = join(getMemoryDir(cwd), "topic.md");
		const topicContent = [
			"---",
			"type: project",
			"description: Existing topic",
			"created_at: 2026-07-09T00:00:00.000Z",
			"updated_at: 2026-07-09T00:00:00.000Z",
			"source: user",
			"confidence: high",
			"stability: evolving",
			"---",
			"",
			"Original topic content.",
		].join("\n");
		await writeFile(topicPath, topicContent);
		const outsideTopicLink = join(cwd, "outside-topic.md");
		await link(topicPath, outsideTopicLink);

		let terminal: Terminal | undefined;
		for await (const event of query({
			initialState: createWriteApprovedState("overwrite hardlinked topic", cwd),
			model: new WritePathModelClient(outsideTopicLink, "INVALID_TOPIC"),
			tools: [writeTool],
		})) {
			if (event.type === "terminal") {
				terminal = event.terminal;
			}
		}
		expect(terminal?.state.observations[0]?.ok).toBe(false);
		expect(terminal?.state.observations[0]?.output).toContain(
			"multiple hard links",
		);
		expect(await readFile(topicPath, "utf8")).toBe(topicContent);

		const indexPath = getMemoryIndexPath(cwd);
		const originalIndex = await readFile(indexPath, "utf8");
		const outsideIndexLink = join(cwd, "outside-index.md");
		await link(indexPath, outsideIndexLink);
		terminal = undefined;
		for await (const event of query({
			initialState: createWriteApprovedState("overwrite hardlinked index", cwd),
			model: new WritePathModelClient(outsideIndexLink, "PWNED_INDEX"),
			tools: [writeTool],
		})) {
			if (event.type === "terminal") {
				terminal = event.terminal;
			}
		}
		expect(terminal?.state.observations[0]?.ok).toBe(false);
		expect(terminal?.state.observations[0]?.output).toContain(
			"multiple hard links",
		);
		expect(await readFile(indexPath, "utf8")).toBe(originalIndex);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("valid main agent memory writes refresh MEMORY.md automatically", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		const memoryPath = join(cwd, ".cagent", "memory", "preference.md");
		const content = [
			"---",
			"type: feedback",
			"description: User prefers concise answers",
			"created_at: 2026-07-09T00:00:00.000Z",
			"updated_at: 2026-07-09T00:00:00.000Z",
			"source: user",
			"confidence: high",
			"stability: evolving",
			"---",
			"",
			"Keep answers concise.",
		].join("\n");
		let terminal: Terminal | undefined;
		for await (const event of query({
			initialState: createWriteApprovedState("remember preference", cwd),
			model: new WritePathModelClient(memoryPath, content),
			tools: [writeTool],
		})) {
			if (event.type === "terminal") {
				terminal = event.terminal;
			}
		}

		expect(terminal?.state.observations[0]?.ok).toBe(true);
		expect(await readFile(getMemoryIndexPath(cwd), "utf8")).toContain(
			"[User prefers concise answers](preference.md)",
		);
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

test("query injects prior tool executions without raw outputs", async () => {
	const cwd = await makeTempDir();
	try {
		const model = new RecordingModelClient();
		const initialState = {
			...createInitialState("continue", cwd),
			toolExecutions: [
				{
					callId: "old-read",
					tool: "Read",
					status: "succeeded" as const,
					target: "file_path=README.md",
					turn: 1,
				},
			],
		};

		for await (const _event of query({ initialState, model, tools: [] })) {
			// Consume the query.
		}

		const prompt = model.requests[0]?.messages.find((message) =>
			message.content.includes("# Session tool execution history"),
		)?.content;
		expect(prompt).toContain("[succeeded] Read");
		expect(prompt).toContain("target=file_path=README.md");
		expect(prompt).toContain("Raw tool outputs are intentionally omitted");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

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
		const memoryPrompt = request?.messages.find((message) =>
			message.content.includes("# cagent memory"),
		)?.content;
		expect(memoryPrompt).toContain("prefers concise answers");
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
