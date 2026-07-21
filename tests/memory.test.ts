import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildMemorySelectionMessages,
	editValidatedMemoryFile,
	ensureMemoryStore,
	formatMemoryManifest,
	formatMemoryStoreSummary,
	formatRelevantMemoriesPrompt,
	getMemoryIndexPath,
	isMemoryExpired,
	loadMemoryPrompt,
	MAX_MEMORY_TOPIC_BYTES,
	MemoryEditConflictError,
	parseSelectedMemoryFilenames,
	readRelevantMemories,
	refreshMemoryIndex,
	scanMemoryFiles,
	validateMemoryFile,
	validateMemoryStore,
	validateMemoryWrite,
	writeValidatedMemoryFile,
} from "../src/memory";

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cagent-memory-"));
}

test("ensureMemoryStore creates an index and lists markdown memory files", async () => {
	const cwd = await makeTempDir();
	try {
		const indexPath = getMemoryIndexPath(cwd);
		let info = await ensureMemoryStore(cwd);

		expect(info.indexPath).toBe(indexPath);
		expect(info.files.map((file) => file.filename)).toEqual(["MEMORY.md"]);
		expect(await readFile(indexPath, "utf-8")).toBe("# Memory\n\n");

		await writeFile(join(cwd, ".cagent", "memory", "preferences.md"), "ok");
		info = await ensureMemoryStore(cwd);

		expect(info.files.map((file) => file.filename)).toEqual([
			"MEMORY.md",
			"preferences.md",
		]);
		expect(formatMemoryStoreSummary(info)).toContain("preferences.md");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("loadMemoryPrompt includes the memory paths and current index", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		await writeFile(
			getMemoryIndexPath(cwd),
			"# Memory\n\n- [Preferences](preferences.md) - prefers concise answers\n",
		);

		const prompt = await loadMemoryPrompt(cwd);

		expect(prompt).toContain("# cagent memory");
		expect(prompt).toContain(join(cwd, ".cagent", "memory"));
		expect(prompt).toContain("prefers concise answers");
		expect(prompt).toContain("Do not save ephemeral task state");
		expect(prompt).toContain("stability: temporary | evolving | durable");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("scanMemoryFiles builds a frontmatter manifest and reads selected memories", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		await writeFile(
			join(cwd, ".cagent", "memory", "preferences.md"),
			[
				"---",
				"type: feedback",
				"description: User prefers concise engineering answers",
				"created_at: 2026-07-09T00:00:00.000Z",
				"updated_at: 2026-07-09T00:00:00.000Z",
				"source: user",
				"confidence: high",
				"stability: evolving",
				"---",
				"",
				"Keep final answers short and focus on concrete changes.",
			].join("\n"),
		);

		const memories = await scanMemoryFiles(cwd);
		const manifest = formatMemoryManifest(memories);

		expect(memories).toHaveLength(1);
		expect(memories[0]?.filename).toBe("preferences.md");
		expect(memories[0]?.metadata.type).toBe("feedback");
		expect(memories[0]?.metadata.confidence).toBe("high");
		expect(memories[0]?.metadata.stability).toBe("evolving");
		expect(manifest).toContain("[feedback] preferences.md");
		expect(manifest).toContain("stability=evolving");

		const selectionMessages = buildMemorySelectionMessages({
			userInput: "how should you answer me?",
			manifest,
		});
		expect(selectionMessages[0]?.content).toContain("selected_memories");

		const selected = parseSelectedMemoryFilenames(
			JSON.stringify({ selected_memories: ["preferences.md", "missing.md"] }),
			memories,
		);
		expect(selected).toEqual(["preferences.md"]);

		const relevant = await readRelevantMemories(memories, selected);
		const prompt = formatRelevantMemoriesPrompt(relevant);
		expect(prompt).toContain("# relevant memories");
		expect(prompt).toContain('path="preferences.md"');
		expect(prompt).toContain("Keep final answers short");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("validateMemoryFile reports metadata issues and expiry is honored", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		const expiredMemory = [
			"---",
			"type: project",
			"description: Temporary branch context",
			"created_at: 2026-07-08T00:00:00.000Z",
			"updated_at: 2026-07-08T00:00:00.000Z",
			"source: assistant",
			"confidence: medium",
			"stability: temporary",
			"ttl: 2026-07-08T01:00:00.000Z",
			"---",
			"",
			"Use branch old-plan.",
		].join("\n");
		await writeFile(
			join(cwd, ".cagent", "memory", "temporary.md"),
			expiredMemory,
		);

		const issues = validateMemoryFile("broken.md", "plain text");
		expect(issues).toContainEqual({
			path: "broken.md",
			message: "missing opening frontmatter delimiter",
		});
		for (const field of [
			"type",
			"description",
			"created_at",
			"updated_at",
			"source",
			"confidence",
			"stability",
		]) {
			expect(issues).toContainEqual({
				path: "broken.md",
				message: `missing ${field}`,
			});
		}
		expect(
			isMemoryExpired(
				{ ttl: "2026-07-08T01:00:00.000Z" },
				new Date("2026-07-09T00:00:00.000Z"),
			),
		).toBe(true);
		expect(await scanMemoryFiles(cwd)).toHaveLength(0);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("refreshMemoryIndex rebuilds MEMORY.md from topic frontmatter", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		await writeFile(
			join(cwd, ".cagent", "memory", "preferences.md"),
			[
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
		);
		await writeFile(
			join(cwd, ".cagent", "memory", "broken.md"),
			"---\ntype: user\n---\n\nMissing metadata.",
		);

		await refreshMemoryIndex(cwd);
		const index = await readFile(getMemoryIndexPath(cwd), "utf-8");

		expect(index).toContain(
			"- [User prefers concise answers](preferences.md) (feedback, evolving)",
		);
		expect(index).toContain(
			"- [Missing memory description](broken.md) (user, 6 metadata issue(s))",
		);
		expect(await validateMemoryStore(cwd)).toEqual([
			{ path: "broken.md", message: "missing description" },
			{ path: "broken.md", message: "missing created_at" },
			{ path: "broken.md", message: "missing updated_at" },
			{ path: "broken.md", message: "missing source" },
			{ path: "broken.md", message: "missing confidence" },
			{ path: "broken.md", message: "missing stability" },
		]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("validateMemoryFile enforces the complete frontmatter schema", () => {
	const validLines = [
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
	];
	expect(validateMemoryFile("valid.md", validLines.join("\n"))).toEqual([]);

	for (const [linePrefix, field] of [
		["type:", "type"],
		["description:", "description"],
		["created_at:", "created_at"],
		["updated_at:", "updated_at"],
		["source:", "source"],
		["confidence:", "confidence"],
		["stability:", "stability"],
	] as const) {
		const content = validLines
			.filter((line) => !line.startsWith(linePrefix))
			.join("\n");
		expect(validateMemoryFile("missing.md", content)).toContainEqual({
			path: "missing.md",
			message: `missing ${field}`,
		});
	}

	expect(
		validateMemoryFile(
			"open.md",
			validLines.filter((_line, index) => index !== 8).join("\n"),
		),
	).toContainEqual({
		path: "open.md",
		message: "missing closing frontmatter delimiter",
	});
	expect(
		validateMemoryFile(
			"invalid.md",
			validLines
				.map((line) => (line === "source: user" ? "source: unknown" : line))
				.join("\n"),
		),
	).toContainEqual({
		path: "invalid.md",
		message: "source must be one of: user, assistant, tool, inferred",
	});

	for (const [original, replacement, expected] of [
		["type: feedback", "type: unknown", "type must be one of"],
		["confidence: high", "confidence: certain", "confidence must be one of"],
		["stability: evolving", "stability: forever", "stability must be one of"],
		[
			"created_at: 2026-07-09T00:00:00.000Z",
			"created_at: yesterday",
			"created_at must be an ISO-8601 timestamp",
		],
		[
			"updated_at: 2026-07-09T00:00:00.000Z",
			"updated_at: tomorrow",
			"updated_at must be an ISO-8601 timestamp",
		],
	] as const) {
		const messages = validateMemoryFile(
			"invalid.md",
			validLines
				.map((line) => (line === original ? replacement : line))
				.join("\n"),
		).map((issue) => issue.message);
		expect(messages.some((message) => message.includes(expected))).toBe(true);
	}

	const delayedClosing = [
		...validLines.slice(0, 8),
		...Array.from({ length: 32 }, (_, index) => `# padding ${index}`),
		...validLines.slice(8),
	].join("\n");
	expect(validateMemoryFile("too-long.md", delayedClosing)).toContainEqual({
		path: "too-long.md",
		message: "missing closing frontmatter delimiter",
	});

	const unknownKey = [...validLines];
	unknownKey.splice(8, 0, "surprise: value");
	expect(
		validateMemoryFile("unknown.md", unknownKey.join("\n")),
	).toContainEqual({
		path: "unknown.md",
		message: "unknown frontmatter key: surprise",
	});
	const duplicateKey = [...validLines];
	duplicateKey.splice(8, 0, "type: user");
	expect(
		validateMemoryFile("duplicate-key.md", duplicateKey.join("\n")),
	).toContainEqual({
		path: "duplicate-key.md",
		message: "duplicate frontmatter key: type",
	});
});

test("memory scanning fails closed when the file limit is exceeded", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		await Promise.all(
			Array.from({ length: 200 }, (_, index) =>
				writeFile(
					join(cwd, ".cagent", "memory", `memory-${index}.md`),
					"invalid",
				),
			),
		);
		await expect(ensureMemoryStore(cwd)).rejects.toThrow(
			"markdown files; limit is 200",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("Windows case aliases update the same memory topic", async () => {
	if (process.platform !== "win32") {
		return;
	}

	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		const topicPath = join(cwd, ".cagent", "memory", "Topic.md");
		const topicAlias = join(cwd, ".cagent", "memory", "topic.md");
		const original = [
			"---",
			"type: project",
			"description: Shared project convention",
			"created_at: 2026-07-09T00:00:00.000Z",
			"updated_at: 2026-07-09T00:00:00.000Z",
			"source: user",
			"confidence: high",
			"stability: evolving",
			"---",
			"",
			"Original convention.",
		].join("\n");
		const updated = original
			.replace(
				"updated_at: 2026-07-09T00:00:00.000Z",
				"updated_at: 2026-07-10T00:00:00.000Z",
			)
			.replace("Original convention.", "Updated convention.");

		await writeValidatedMemoryFile(cwd, topicPath, original);
		expect(await validateMemoryWrite(cwd, topicAlias, updated)).toEqual([]);
		await writeValidatedMemoryFile(cwd, topicAlias, updated);
		expect(await readFile(topicPath, "utf8")).toContain("Updated convention.");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("concurrent memory writes cannot bypass duplicate validation", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		const makeContent = (body: string) =>
			[
				"---",
				"type: project",
				"description: One shared convention",
				"created_at: 2026-07-10T00:00:00.000Z",
				"updated_at: 2026-07-10T00:00:00.000Z",
				"source: user",
				"confidence: high",
				"stability: evolving",
				"---",
				"",
				body,
			].join("\n");
		const results = await Promise.allSettled([
			writeValidatedMemoryFile(
				cwd,
				join(cwd, ".cagent", "memory", "a.md"),
				makeContent("First body."),
			),
			writeValidatedMemoryFile(
				cwd,
				join(cwd, ".cagent", "memory", "b.md"),
				makeContent("Second body."),
			),
		]);

		expect(results.map((result) => result.status).sort()).toEqual([
			"fulfilled",
			"rejected",
		]);
		expect(await validateMemoryStore(cwd)).toEqual([]);
		const index = await readFile(getMemoryIndexPath(cwd), "utf8");
		expect((index.match(/One shared convention/g) ?? []).length).toBe(1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("concurrent memory edits serialize the full transaction and report conflicts", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		const topicPath = join(cwd, ".cagent", "memory", "shared.md");
		const original = [
			"---",
			"type: project",
			"description: Original shared convention",
			"created_at: 2026-07-21T00:00:00.000Z",
			"updated_at: 2026-07-21T00:00:00.000Z",
			"source: user",
			"confidence: high",
			"stability: evolving",
			"---",
			"",
			"Keep the original convention.",
		].join("\n");
		await writeValidatedMemoryFile(cwd, topicPath, original);

		const results = await Promise.allSettled([
			editValidatedMemoryFile(
				cwd,
				topicPath,
				"Original shared convention",
				"Updated shared convention",
			),
			editValidatedMemoryFile(
				cwd,
				topicPath,
				"Original shared convention",
				"Updated shared convention",
			),
		]);

		expect(results.map((result) => result.status).sort()).toEqual([
			"fulfilled",
			"rejected",
		]);
		const rejected = results.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		expect(rejected?.reason).toBeInstanceOf(MemoryEditConflictError);
		expect(String(rejected?.reason)).toContain("Memory edit conflict");
		expect(await readFile(topicPath, "utf8")).toContain(
			"description: Updated shared convention",
		);
		const index = await readFile(getMemoryIndexPath(cwd), "utf8");
		expect(index).toContain("[Updated shared convention](shared.md)");
		expect(index).not.toContain("Original shared convention");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory topic writes enforce a byte limit before writing", async () => {
	const cwd = await makeTempDir();
	try {
		await ensureMemoryStore(cwd);
		const oversizedPath = join(cwd, ".cagent", "memory", "oversized.md");
		const oversized = [
			"---",
			"type: project",
			"description: Oversized memory",
			"created_at: 2026-07-10T00:00:00.000Z",
			"updated_at: 2026-07-10T00:00:00.000Z",
			"source: user",
			"confidence: high",
			"stability: evolving",
			"---",
			"",
			"x".repeat(MAX_MEMORY_TOPIC_BYTES),
		].join("\n");

		await expect(
			writeValidatedMemoryFile(cwd, oversizedPath, oversized),
		).rejects.toThrow(`must not exceed ${MAX_MEMORY_TOPIC_BYTES} bytes`);
		await expect(readFile(oversizedPath, "utf8")).rejects.toThrow();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
