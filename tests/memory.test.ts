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
	loadMemoryPrompt,
	parseSelectedMemoryFilenames,
	readRelevantMemories,
	scanMemoryFiles,
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
		expect(info.files).toEqual(["MEMORY.md"]);
		expect(await readFile(indexPath, "utf-8")).toBe("# Memory\n\n");

		await writeFile(join(cwd, ".cagent", "memory", "preferences.md"), "ok");
		info = await ensureMemoryStore(cwd);

		expect(info.files).toEqual(["MEMORY.md", "preferences.md"]);
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
				"---",
				"",
				"Keep final answers short and focus on concrete changes.",
			].join("\n"),
		);

		const memories = await scanMemoryFiles(cwd);
		const manifest = formatMemoryManifest(memories);

		expect(memories).toHaveLength(1);
		expect(memories[0]?.filename).toBe("preferences.md");
		expect(memories[0]?.type).toBe("feedback");
		expect(manifest).toContain("[feedback] preferences.md");

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
