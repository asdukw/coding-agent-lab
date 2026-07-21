import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureMemoryStore,
	getMemoryIndexPath,
	writeValidatedMemoryFile,
} from "../../src/memory";

async function waitForFiles(paths: string[]): Promise<void> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const ready = await Promise.all(
			paths.map((path) =>
				access(path).then(
					() => true,
					() => false,
				),
			),
		);
		if (ready.every(Boolean)) {
			return;
		}
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for memory edit workers");
		}
		await Bun.sleep(10);
	}
}

test("independent Bun processes serialize edits to the same memory topic", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-memory-process-"));
	const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
	try {
		await ensureMemoryStore(cwd);
		const topicPath = join(cwd, ".cagent", "memory", "shared.md");
		const gatePath = join(cwd, "start-edit");
		const readyPaths = [join(cwd, "ready-a"), join(cwd, "ready-b")];
		const original = [
			"---",
			"type: project",
			"description: Original process convention",
			"created_at: 2026-07-21T00:00:00.000Z",
			"updated_at: 2026-07-21T00:00:00.000Z",
			"source: user",
			"confidence: high",
			"stability: evolving",
			"---",
			"",
			"Shared across processes.",
		].join("\n");
		await writeValidatedMemoryFile(cwd, topicPath, original);

		const workerPath = join(
			import.meta.dir,
			"..",
			"fixtures",
			"memory-edit-worker.ts",
		);
		for (const readyPath of readyPaths) {
			children.push(
				Bun.spawn(
					[
						process.execPath,
						"--no-env-file",
						workerPath,
						cwd,
						topicPath,
						gatePath,
						readyPath,
						"Original process convention",
						"Updated process convention",
					],
					{ cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
				),
			);
		}

		await waitForFiles(readyPaths);
		await writeFile(gatePath, "start", "utf8");
		const outputs = await Promise.all(
			children.map(async (child) => {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(exitCode, stderr).toBe(0);
				return JSON.parse(stdout.trim()) as {
					status: "success" | "conflict" | "failure";
					message?: string;
				};
			}),
		);

		expect(outputs.map((output) => output.status).sort()).toEqual([
			"conflict",
			"success",
		]);
		expect(
			outputs.find((output) => output.status === "conflict")?.message,
		).toContain("Memory edit conflict");
		expect(await readFile(topicPath, "utf8")).toContain(
			"description: Updated process convention",
		);
		const index = await readFile(getMemoryIndexPath(cwd), "utf8");
		expect(index).toContain("[Updated process convention](shared.md)");
		expect(index).not.toContain("Original process convention");
	} finally {
		for (const child of children) {
			child.kill();
		}
		await rm(cwd, { recursive: true, force: true });
	}
});
