import { expect, test } from "bun:test";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	ensureMemoryStore,
	getMemoryDir,
	MAX_MEMORY_TOPIC_BYTES,
} from "../src/memory";
import { createInitialState } from "../src/state";
import { BUILTIN_TOOLS } from "../src/tools";
import { editTool } from "../src/tools/editTool";
import { globTool } from "../src/tools/globTool";
import { grepTool } from "../src/tools/grepTool";
import { getToolPermissionDecision } from "../src/tools/permissions";
import { readTool } from "../src/tools/readTool";
import { RuntimeResourceLock } from "../src/tools/resourceLock";
import { runToolCalls } from "../src/tools/runner";
import type { Tool, ToolContext } from "../src/tools/types";
import { writeTool } from "../src/tools/writeTool";

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cagent-tools-"));
}

test("built-in tools declare resource access plans", async () => {
	const dir = await makeTempDir();
	try {
		let state = createInitialState("inspect", dir);
		const context: ToolContext = {
			getState: () => state,
			setState(next) {
				state = typeof next === "function" ? next(state) : next;
			},
		};
		const metadata = new Map(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));
		for (const tool of BUILTIN_TOOLS) {
			expect(tool.getResourceAccesses).toBeFunction();
		}

		const readAccesses = await readTool.getResourceAccesses?.(
			{ file_path: join(dir, "read.txt") },
			context,
		);
		expect(readAccesses?.[0]).toMatchObject({
			namespace: "fs",
			mode: "read",
			scope: "exact",
		});

		const writeAccesses = await writeTool.getResourceAccesses?.(
			{ file_path: join(dir, "write.txt"), content: "content" },
			context,
		);
		expect(writeAccesses?.[0]).toMatchObject({
			namespace: "fs",
			mode: "write",
			scope: "exact",
		});

		const planAccesses = await metadata
			.get("EnterPlanMode")
			?.getResourceAccesses?.({}, context);
		expect(planAccesses).toEqual([
			{
				namespace: "session",
				key: state.sessionId,
				mode: "write",
				scope: "exact",
			},
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readTool reads full content and reports totalLines", async () => {
	const dir = await makeTempDir();
	const filePath = join(dir, "a.txt");
	await writeFile(filePath, "one\ntwo\nthree");

	const result = await readTool.call({ file_path: filePath });

	expect(result.content).toBe("one\ntwo\nthree");
	expect(result.totalLines).toBe(3);
});

test("readTool respects offset and limit", async () => {
	const dir = await makeTempDir();
	const filePath = join(dir, "a.txt");
	await writeFile(filePath, "one\ntwo\nthree\nfour");

	const result = await readTool.call({
		file_path: filePath,
		offset: 2,
		limit: 2,
	});

	expect(result.content).toBe("two\nthree");
});

test("readTool rejects a missing file", async () => {
	const dir = await makeTempDir();
	await expect(
		readTool.call({ file_path: join(dir, "missing.txt") }),
	).rejects.toThrow();
});

test("writeTool creates parent directories and writes content", async () => {
	const dir = await makeTempDir();
	const filePath = join(dir, "nested", "b.txt");

	const result = await writeTool.call({
		file_path: filePath,
		content: "hello",
	});

	expect(result.bytesWritten).toBe(5);
	expect(await readFile(filePath, "utf-8")).toBe("hello");
});

test("editTool replaces a unique match", async () => {
	const dir = await makeTempDir();
	const filePath = join(dir, "c.txt");
	await writeFile(filePath, "hello world");

	const result = await editTool.call({
		file_path: filePath,
		old_string: "world",
		new_string: "there",
	});

	expect(result.replacements).toBe(1);
	expect(await readFile(filePath, "utf-8")).toBe("hello there");
});

test("editTool rejects an ambiguous match without replace_all", async () => {
	const dir = await makeTempDir();
	const filePath = join(dir, "c.txt");
	await writeFile(filePath, "foo foo");

	await expect(
		editTool.call({
			file_path: filePath,
			old_string: "foo",
			new_string: "bar",
		}),
	).rejects.toThrow();
});

test("editTool replaces every match with replace_all", async () => {
	const dir = await makeTempDir();
	const filePath = join(dir, "c.txt");
	await writeFile(filePath, "foo foo");

	const result = await editTool.call({
		file_path: filePath,
		old_string: "foo",
		new_string: "bar",
		replace_all: true,
	});

	expect(result.replacements).toBe(2);
	expect(await readFile(filePath, "utf-8")).toBe("bar bar");
});

test("editTool rejects oversized memory before reading it in full", async () => {
	const dir = await makeTempDir();
	try {
		await ensureMemoryStore(dir);
		const memoryPath = join(getMemoryDir(dir), "oversized.md");
		await writeFile(memoryPath, "x".repeat(MAX_MEMORY_TOPIC_BYTES + 1));
		const state = createInitialState("edit memory", dir);
		const context: ToolContext = {
			getState: () => state,
			setState() {},
		};

		await expect(
			editTool.call(
				{
					file_path: memoryPath,
					old_string: "x",
					new_string: "y",
				},
				context,
			),
		).rejects.toThrow(`must not exceed ${MAX_MEMORY_TOPIC_BYTES} bytes`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("globTool finds files matching a pattern", async () => {
	const dir = await makeTempDir();
	await writeFile(join(dir, "a.ts"), "");
	await writeFile(join(dir, "b.md"), "");

	const result = await globTool.call({ pattern: "*.ts", path: dir });

	expect(result.filenames).toEqual(["a.ts"]);
});

test("grepTool finds matching files and lines", async () => {
	const dir = await makeTempDir();
	await writeFile(join(dir, "a.txt"), "hello world\nsomething else");
	await writeFile(join(dir, "b.txt"), "nothing here");

	const filesResult = await grepTool.call({ pattern: "hello", path: dir });
	expect(filesResult.output).toBe("a.txt");

	const contentResult = await grepTool.call({
		pattern: "hello",
		path: dir,
		output_mode: "content",
	});
	expect(contentResult.output).toBe("a.txt:1:hello world");

	const countResult = await grepTool.call({
		pattern: "o",
		path: dir,
		output_mode: "count",
	});
	expect(countResult.output).toBe("3");
});

test("globTool and grepTool filter protected paths from explicit patterns", async () => {
	const dir = await makeTempDir();
	try {
		await writeFile(join(dir, ".env.local"), "secret marker");
		await link(join(dir, ".env.local"), join(dir, "secret-alias.txt"));
		await writeFile(join(dir, "visible.txt"), "public marker");
		let state = createInitialState("inspect protected paths", dir);
		const context: ToolContext = {
			getState: () => state,
			setState(next) {
				state = typeof next === "function" ? next(state) : next;
			},
		};

		const protectedGlob = await globTool.call(
			{ pattern: ".env.local", path: dir },
			context,
		);
		expect(protectedGlob.filenames).toEqual([]);
		const hardLinkGlob = await globTool.call(
			{ pattern: "secret-alias.txt", path: dir },
			context,
		);
		expect(hardLinkGlob.filenames).toEqual([]);

		const protectedGrep = await grepTool.call(
			{ pattern: "secret", path: dir, glob: ".env.local" },
			context,
		);
		expect(protectedGrep.output).toBe("");
		const hardLinkRead = await getToolPermissionDecision(state, readTool, {
			file_path: join(dir, "secret-alias.txt"),
		});
		expect(hardLinkRead.kind).toBe("deny");

		const visibleGrep = await grepTool.call(
			{ pattern: "public", path: dir, glob: "visible.txt" },
			context,
		);
		expect(visibleGrep.output).toBe("visible.txt");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("runtime resource lock supports readers, writer fairness, and subtree conflicts", async () => {
	const locks = new RuntimeResourceLock();
	const root = join(process.cwd(), "locked-tree");
	const file = join(root, "file.txt");
	const unrelated = join(process.cwd(), "other-tree", "file.txt");
	const releaseTreeRead = await locks.acquire([
		{ namespace: "fs", key: root, scope: "subtree", mode: "read" },
	]);
	const releaseFileRead = await locks.acquire([
		{ namespace: "fs", key: file, scope: "exact", mode: "read" },
	]);

	let writerAcquired = false;
	const writer = locks
		.acquire([{ namespace: "fs", key: file, scope: "exact", mode: "write" }])
		.then((release) => {
			writerAcquired = true;
			return release;
		});
	let lateReaderAcquired = false;
	const lateReader = locks
		.acquire([{ namespace: "fs", key: file, scope: "exact", mode: "read" }])
		.then((release) => {
			lateReaderAcquired = true;
			return release;
		});
	await Promise.resolve();
	expect(writerAcquired).toBe(false);
	expect(lateReaderAcquired).toBe(false);

	const releaseUnrelated = await locks.acquire([
		{ namespace: "fs", key: unrelated, scope: "exact", mode: "write" },
	]);
	releaseUnrelated();
	releaseTreeRead();
	releaseFileRead();

	const releaseWriter = await writer;
	expect(writerAcquired).toBe(true);
	await Promise.resolve();
	expect(lateReaderAcquired).toBe(false);
	releaseWriter();
	const releaseLateReader = await lateReader;
	expect(lateReaderAcquired).toBe(true);
	releaseLateReader();
});

test("runToolCalls executes independent resources concurrently and preserves result order", async () => {
	const inputSchema = z.object({
		resource: z.string(),
		delay: z.number(),
	});
	let active = 0;
	let maxActive = 0;
	const tool: Tool<z.infer<typeof inputSchema>, { resource: string }> = {
		name: "ResourceTool",
		description: "Exercise resource-aware scheduling",
		inputSchema,
		getResourceAccesses(input) {
			return [
				{
					namespace: "runtime",
					key: input.resource,
					mode: "write",
					scope: "exact",
				},
			];
		},
		async call(input) {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolveDelay) =>
				setTimeout(resolveDelay, input.delay),
			);
			active--;
			return { resource: input.resource };
		},
	};
	const state = createInitialState("schedule", process.cwd());
	const context = {
		getState: () => state,
		setState() {},
	};
	const results = await runToolCalls({
		calls: [
			{
				id: "slow",
				name: tool.name,
				arguments: JSON.stringify({ resource: "a", delay: 20 }),
			},
			{
				id: "fast",
				name: tool.name,
				arguments: JSON.stringify({ resource: "b", delay: 1 }),
			},
		],
		tools: [tool],
		context,
		lockManager: new RuntimeResourceLock(),
	});

	expect(maxActive).toBe(2);
	expect(results.map((result) => result.call.id)).toEqual(["slow", "fast"]);

	active = 0;
	maxActive = 0;
	await runToolCalls({
		calls: [
			{
				id: "first",
				name: tool.name,
				arguments: JSON.stringify({ resource: "same", delay: 5 }),
			},
			{
				id: "second",
				name: tool.name,
				arguments: JSON.stringify({ resource: "same", delay: 5 }),
			},
		],
		tools: [tool],
		context,
		lockManager: new RuntimeResourceLock(),
	});
	expect(maxActive).toBe(1);
});
