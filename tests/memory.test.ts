import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureMemoryStore,
	formatMemoryStoreSummary,
	getMemoryIndexPath,
	loadMemoryPrompt,
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
