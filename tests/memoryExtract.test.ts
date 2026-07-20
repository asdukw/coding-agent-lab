import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	access,
	link,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureMemoryStore,
	getMemoryDir,
	MAX_MEMORY_TOPIC_BYTES,
} from "../src/memory";
import { runMemoryExtractionSubAgent } from "../src/memoryExtract";
import type {
	ModelClient,
	ModelRequest,
	ModelStreamEvent,
} from "../src/model/client";
import { createInitialState } from "../src/state";

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cagent-memory-extract-"));
}

function memoryContent(description: string, body: string): string {
	return [
		"---",
		"type: feedback",
		`description: ${description}`,
		"created_at: 2026-07-09T00:00:00.000Z",
		"updated_at: 2026-07-09T00:00:00.000Z",
		"source: user",
		"confidence: high",
		"stability: evolving",
		"---",
		"",
		body,
	].join("\n");
}

function memoryState(cwd: string, sessionId = "main-session") {
	return {
		...createInitialState("please remember I like concise answers", cwd),
		sessionId,
		turn: 1,
		messages: [
			{
				role: "user" as const,
				content: "please remember I like concise answers",
			},
			{ role: "assistant" as const, content: "I'll keep that in mind." },
		],
	};
}

class MemoryWritingModelClient implements ModelClient {
	readonly name = "memory-writer";
	readonly requests: ModelRequest[] = [];
	private callCount = 0;

	constructor(
		private readonly cwd: string,
		private readonly finalAnswer = "saved preferences.md",
	) {}

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.requests.push(request);
		if (
			request.toolSpecs?.length === 0 &&
			request.messages.some((message) =>
				message.content.includes("select cagent memory files"),
			)
		) {
			yield {
				type: "text_delta",
				content: JSON.stringify({ selected_memories: ["preferences.md"] }),
			};
			return;
		}

		this.callCount++;
		if (this.callCount === 1) {
			expect(request.toolSpecs?.map((tool) => tool.name)).toContain("Write");
			yield {
				type: "tool_call",
				id: "write-memory",
				name: "Write",
				arguments: JSON.stringify({
					file_path: join(getMemoryDir(this.cwd), "preferences.md"),
					content: [
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
					].join("\n"),
				}),
			};
			return;
		}

		yield { type: "text_delta", content: this.finalAnswer };
	}
}

class MemoryEscapingModelClient implements ModelClient {
	readonly name = "memory-escaping";
	private callCount = 0;

	constructor(private readonly cwd: string) {}

	async *stream(_request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.callCount++;
		if (this.callCount === 1) {
			yield {
				type: "tool_call",
				id: "write-outside-memory",
				name: "Write",
				arguments: JSON.stringify({
					file_path: join(this.cwd, "outside.md"),
					content: "should not be written",
				}),
			};
			return;
		}

		yield { type: "text_delta", content: "done" };
	}
}

class InvalidMemoryWritingModelClient implements ModelClient {
	readonly name = "invalid-memory-writer";
	private callCount = 0;

	constructor(private readonly cwd: string) {}

	async *stream(_request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.callCount++;
		if (this.callCount === 1) {
			yield {
				type: "tool_call",
				id: "write-invalid-memory",
				name: "Write",
				arguments: JSON.stringify({
					file_path: join(getMemoryDir(this.cwd), "invalid.md"),
					content: "---\ntype: feedback\n---\n\nMissing required metadata.",
				}),
			};
			return;
		}

		yield { type: "text_delta", content: "saved invalid.md" };
	}
}

class PathWritingModelClient implements ModelClient {
	readonly name = "path-writer";
	private callCount = 0;

	constructor(
		private readonly filePath: string,
		private readonly content: string,
	) {}

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		if (
			request.toolSpecs?.length === 0 &&
			request.messages.some((message) =>
				message.content.includes("select cagent memory files"),
			)
		) {
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
				id: "write-path",
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

class PartialWriteThenThrowModelClient implements ModelClient {
	readonly name = "partial-write-then-throw";
	private callCount = 0;

	constructor(private readonly cwd: string) {}

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		if (
			request.toolSpecs?.length === 0 &&
			request.messages.some((message) =>
				message.content.includes("select cagent memory files"),
			)
		) {
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
				id: "write-before-error",
				name: "Write",
				arguments: JSON.stringify({
					file_path: join(getMemoryDir(this.cwd), "partial.md"),
					content: memoryContent(
						"Partial write survives",
						"Saved before failure.",
					),
				}),
			};
			return;
		}
		throw new Error("model exploded after write");
	}
}

class MaxTurnModelClient implements ModelClient {
	readonly name = "max-turn-reader";

	constructor(private readonly cwd: string) {}

	async *stream(): AsyncGenerator<ModelStreamEvent> {
		yield {
			type: "tool_call",
			id: `read-memory-${randomUUID()}`,
			name: "Read",
			arguments: JSON.stringify({
				file_path: join(getMemoryDir(this.cwd), "MEMORY.md"),
			}),
		};
	}
}

class BlockingNoMemoryModelClient implements ModelClient {
	readonly name = "blocking-no-memory";
	readonly entered: Promise<void>;
	calls = 0;
	private readonly gate: Promise<void>;
	private markEntered: () => void = () => undefined;
	private releaseGate: () => void = () => undefined;

	constructor() {
		this.entered = new Promise((resolveEntered) => {
			this.markEntered = () => resolveEntered();
		});
		this.gate = new Promise((resolveGate) => {
			this.releaseGate = () => resolveGate();
		});
	}

	release(): void {
		this.releaseGate();
	}

	async *stream(): AsyncGenerator<ModelStreamEvent> {
		this.calls++;
		this.markEntered();
		await this.gate;
		yield { type: "text_delta", content: "NO_MEMORY" };
	}
}

class NoMemoryModelClient implements ModelClient {
	readonly name = "no-memory";
	calls = 0;

	async *stream(): AsyncGenerator<ModelStreamEvent> {
		this.calls++;
		yield { type: "text_delta", content: "NO_MEMORY" };
	}
}

class UnexpectedNoWriteModelClient implements ModelClient {
	readonly name = "unexpected-no-write";

	async *stream(): AsyncGenerator<ModelStreamEvent> {
		yield {
			type: "text_delta",
			content: `unexpected raw response ${"sensitive-prompt ".repeat(100)}`,
		};
	}
}

test("memory extraction sub agent can write memory files", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		await writeFile(
			join(getMemoryDir(cwd), "preferences.md"),
			[
				"---",
				"type: feedback",
				"description: Existing concise answer preference",
				"created_at: 2026-07-08T00:00:00.000Z",
				"updated_at: 2026-07-08T00:00:00.000Z",
				"source: user",
				"confidence: high",
				"stability: evolving",
				"---",
				"",
				"Old concise preference.",
			].join("\n"),
		);
		const state = {
			...createInitialState("please remember I like concise answers", cwd),
			sessionId: "main-session",
			turn: 1,
			messages: [
				{
					role: "user" as const,
					content: "please remember I like concise answers",
				},
				{ role: "assistant" as const, content: "I'll keep that in mind." },
			],
		};
		const model = new MemoryWritingModelClient(cwd);
		const result = await runMemoryExtractionSubAgent({
			state,
			model,
		});

		expect(result).toEqual({
			subAgentSessionId: "main-session.memory.1",
			ok: true,
			summary: "memory updated: preferences.md",
		});
		expect(
			await readFile(join(getMemoryDir(cwd), "preferences.md"), "utf8"),
		).toContain("Keep answers concise.");
		const firstRequestText = model.requests[0]?.messages
			.map((message) => message.content)
			.join("\n");
		expect(firstRequestText).toContain("Existing topic manifest:");
		expect(firstRequestText).toContain("Existing concise answer preference");
		expect(firstRequestText).toContain("Old concise preference.");
		expect(
			await readFile(join(getMemoryDir(cwd), "MEMORY.md"), "utf8"),
		).toContain(
			"- [User prefers concise answers](preferences.md) (feedback, evolving)",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory extraction rejects a non-protocol response without writes", async () => {
	const cwd = await makeTempDir();
	try {
		const result = await runMemoryExtractionSubAgent({
			state: memoryState(cwd, "protocol-session"),
			model: new UnexpectedNoWriteModelClient(),
		});

		expect(result).toEqual({
			subAgentSessionId: "protocol-session.memory.1",
			ok: false,
			reason: "protocol_error",
			reasons: ["protocol_error"],
			summary:
				"memory protocol failed: extraction completed without NO_MEMORY or a memory topic write",
		});
		expect(result.summary).not.toContain("sensitive-prompt");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory extraction replaces an oversized raw reply with a bounded summary", async () => {
	const cwd = await makeTempDir();
	try {
		const result = await runMemoryExtractionSubAgent({
			state: memoryState(cwd, "bounded-summary-session"),
			model: new MemoryWritingModelClient(
				cwd,
				`sensitive raw response\n${"x".repeat(1_000)}`,
			),
		});

		expect(result).toEqual({
			subAgentSessionId: "bounded-summary-session.memory.1",
			ok: true,
			summary: "memory updated: preferences.md",
		});
		expect(result.summary).not.toContain("sensitive raw response");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory extraction sub agent cannot write outside memory files", async () => {
	const cwd = await makeTempDir();
	try {
		const state = {
			...createInitialState("please remember I like concise answers", cwd),
			sessionId: "main-session",
			turn: 1,
			messages: [
				{
					role: "user" as const,
					content: "please remember I like concise answers",
				},
				{ role: "assistant" as const, content: "I'll keep that in mind." },
			],
		};
		const result = await runMemoryExtractionSubAgent({
			state,
			model: new MemoryEscapingModelClient(cwd),
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("tool_error");
		expect(result.summary).toContain("Memory sub agent can only write files");
		await expect(access(join(cwd, "outside.md"))).rejects.toThrow();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory extraction reports frontmatter validation failures", async () => {
	const cwd = await makeTempDir();
	try {
		const state = {
			...createInitialState("please remember I like concise answers", cwd),
			sessionId: "main-session",
			turn: 1,
			messages: [
				{
					role: "user" as const,
					content: "please remember I like concise answers",
				},
				{ role: "assistant" as const, content: "I'll keep that in mind." },
			],
		};
		const result = await runMemoryExtractionSubAgent({
			state,
			model: new InvalidMemoryWritingModelClient(cwd),
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("tool_error");
		expect(result.subAgentSessionId).toBe("main-session.memory.1");
		expect(result.summary).toContain("Invalid memory file");
		expect(result.summary).toContain("missing description");
		await expect(
			access(join(getMemoryDir(cwd), "invalid.md")),
		).rejects.toThrow();
		expect(await readFile(join(getMemoryDir(cwd), "MEMORY.md"), "utf8")).toBe(
			"# Memory\n\n",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory extraction rejects symlink and junction escapes", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		const outsideDir = join(cwd, "outside");
		const linkedDir = join(getMemoryDir(cwd), "linked");
		await mkdir(outsideDir, { recursive: true });
		await symlink(
			outsideDir,
			linkedDir,
			process.platform === "win32" ? "junction" : "dir",
		);

		const result = await runMemoryExtractionSubAgent({
			state: memoryState(cwd, "symlink-session"),
			model: new PathWritingModelClient(
				join(linkedDir, "escaped.md"),
				memoryContent("Escaped memory", "Must stay inside memory."),
			),
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("tool_error");
		await expect(access(join(outsideDir, "escaped.md"))).rejects.toThrow();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory extraction replaces hardlinks without modifying the external inode", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		const outsidePath = join(cwd, "outside.txt");
		const hardlinkPath = join(getMemoryDir(cwd), "hardlink.md");
		await writeFile(outsidePath, "outside must remain unchanged");
		await link(outsidePath, hardlinkPath);

		const result = await runMemoryExtractionSubAgent({
			state: memoryState(cwd, "hardlink-session"),
			model: new PathWritingModelClient(
				hardlinkPath,
				memoryContent("Safe hardlink replacement", "Stored only in memory."),
			),
		});

		expect(result.ok).toBe(true);
		expect(await readFile(outsidePath, "utf8")).toBe(
			"outside must remain unchanged",
		);
		expect(await readFile(hardlinkPath, "utf8")).toContain(
			"Stored only in memory.",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory extraction cannot overwrite MEMORY.md through a case alias", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		const result = await runMemoryExtractionSubAgent({
			state: memoryState(cwd, "index-alias-session"),
			model: new PathWritingModelClient(
				join(getMemoryDir(cwd), "memory.md"),
				memoryContent("Index overwrite", "Must be denied."),
			),
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("tool_error");
		expect(result.summary).toContain("MEMORY.md is managed automatically");
		expect(await readFile(join(getMemoryDir(cwd), "MEMORY.md"), "utf8")).toBe(
			"# Memory\n\n",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory extraction rejects a duplicate topic description", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		await writeFile(
			join(getMemoryDir(cwd), "preferences.md"),
			memoryContent("User prefers concise answers", "Keep answers short."),
		);
		const duplicatePath = join(getMemoryDir(cwd), "concise-again.md");
		const result = await runMemoryExtractionSubAgent({
			state: memoryState(cwd, "duplicate-session"),
			model: new PathWritingModelClient(
				duplicatePath,
				memoryContent(
					"User prefers concise answers",
					"A differently worded duplicate body.",
				),
			),
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("tool_error");
		expect(result.summary).toContain("duplicates existing memory description");
		await expect(access(duplicatePath)).rejects.toThrow();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory extraction refreshes MEMORY.md after a partial write and query error", async () => {
	const cwd = await makeTempDir();
	try {
		const result = await runMemoryExtractionSubAgent({
			state: memoryState(cwd, "partial-session"),
			model: new PartialWriteThenThrowModelClient(cwd),
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("model_error");
		expect(result.reasons).toContain("model_error");
		expect(result.summary).toContain("model exploded after write");
		expect(
			await readFile(join(getMemoryDir(cwd), "MEMORY.md"), "utf8"),
		).toContain("[Partial write survives](partial.md)");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory extraction reports max turns as a failure", async () => {
	const cwd = await makeTempDir();
	try {
		const result = await runMemoryExtractionSubAgent({
			state: memoryState(cwd, "max-turns-session"),
			model: new MaxTurnModelClient(cwd),
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("max_turns");
		expect(result.summary).toContain("memory query ended with max_turns");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory extractions for one workspace run serially", async () => {
	const cwd = await makeTempDir();
	const alias = `${cwd}-alias`;
	try {
		await symlink(
			cwd,
			alias,
			process.platform === "win32" ? "junction" : "dir",
		);
		const firstModel = new BlockingNoMemoryModelClient();
		const secondModel = new NoMemoryModelClient();
		const first = runMemoryExtractionSubAgent({
			state: memoryState(cwd, "serial-first"),
			model: firstModel,
		});
		await firstModel.entered;
		const second = runMemoryExtractionSubAgent({
			state: memoryState(alias, "serial-second"),
			model: secondModel,
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(secondModel.calls).toBe(0);
		firstModel.release();
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.ok).toBe(true);
		expect(secondResult.ok).toBe(true);
		expect(secondModel.calls).toBe(1);
	} finally {
		await unlink(alias).catch(() => undefined);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("pre-existing legacy validation issues do not fail a NO_MEMORY extraction", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		await writeFile(
			join(getMemoryDir(cwd), "legacy.md"),
			[
				"---",
				"type: project",
				"description: Legacy memory",
				"stability: evolving",
				"---",
				"",
				"Created before strict validation.",
			].join("\n"),
		);

		const result = await runMemoryExtractionSubAgent({
			state: memoryState(cwd, "legacy-session"),
			model: new NoMemoryModelClient(),
		});

		expect(result).toEqual({
			subAgentSessionId: "legacy-session.memory.1",
			ok: true,
			summary: "NO_MEMORY",
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory extraction fails before the model when an existing topic is oversized", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		await writeFile(
			join(getMemoryDir(cwd), "oversized.md"),
			memoryContent(
				"Oversized existing memory",
				"x".repeat(MAX_MEMORY_TOPIC_BYTES),
			),
		);
		const model = new NoMemoryModelClient();

		const result = await runMemoryExtractionSubAgent({
			state: memoryState(cwd, "oversized-session"),
			model,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("preflight_error");
		expect(result.reasons).toContain("validation_error");
		expect(result.summary).toContain("exceeds");
		expect(model.calls).toBe(0);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
