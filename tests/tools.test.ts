import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_TOOLS } from "../src/tools";
import { editTool } from "../src/tools/editTool";
import { globTool } from "../src/tools/globTool";
import { grepTool } from "../src/tools/grepTool";
import { readTool } from "../src/tools/readTool";
import { writeTool } from "../src/tools/writeTool";

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cagent-tools-"));
}

test("built-in tools declare read-only and concurrency metadata", () => {
	const metadata = new Map(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));

	for (const name of ["Read", "Glob", "Grep"]) {
		expect(metadata.get(name)?.isReadOnly).toBe(true);
		expect(metadata.get(name)?.isConcurrencySafe).toBe(true);
	}

	for (const name of [
		"Write",
		"Edit",
		"EnterPlanMode",
		"UpdatePlan",
		"ExitPlanMode",
	]) {
		expect(metadata.get(name)?.isReadOnly).toBe(false);
		expect(metadata.get(name)?.isConcurrencySafe).toBe(false);
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
