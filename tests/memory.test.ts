import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildMemorySelectionMessages,
	ensureMemoryStore,
	formatMemoryManifest,
	formatMemoryStoreSummary,
	formatRelevantMemoriesPrompt,
	getMemoryIndexPath,
	isMemoryExpired,
	loadMemoryPrompt,
	parseSelectedMemoryFilenames,
	readRelevantMemories,
	scanMemoryFiles,
	validateMemoryFile,
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

		expect(validateMemoryFile("broken.md", "plain text")).toEqual([
			{ path: "broken.md", message: "missing type" },
			{ path: "broken.md", message: "missing description" },
			{ path: "broken.md", message: "missing stability" },
		]);
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
