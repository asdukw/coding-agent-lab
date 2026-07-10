import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMemoryStore, getMemoryDir } from "../src/memory";
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

class MemoryWritingModelClient implements ModelClient {
	readonly name = "memory-writer";
	readonly requests: ModelRequest[] = [];
	private callCount = 0;

	constructor(private readonly cwd: string) {}

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

		yield { type: "text_delta", content: "saved preferences.md" };
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
			summary: "saved preferences.md",
		});
		expect(
			await readFile(join(getMemoryDir(cwd), "preferences.md"), "utf8"),
		).toContain("Keep answers concise.");
		const firstRequestText = model.requests[0]?.messages
			.map((message) => message.content)
			.join("\n");
		expect(firstRequestText).toContain("Existing topic manifest:");
		expect(firstRequestText).toContain("Existing concise answer preference");
		expect(
			await readFile(join(getMemoryDir(cwd), "MEMORY.md"), "utf8"),
		).toContain(
			"- [User prefers concise answers](preferences.md) (feedback, evolving)",
		);
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

		expect(result).toEqual({
			subAgentSessionId: "main-session.memory.1",
			ok: true,
			summary: "done",
		});
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
		expect(result.subAgentSessionId).toBe("main-session.memory.1");
		expect(result.summary).toContain("memory validation failed");
		expect(result.summary).toContain("invalid.md: missing description");
		expect(
			await readFile(join(getMemoryDir(cwd), "MEMORY.md"), "utf8"),
		).toContain("metadata issue");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
