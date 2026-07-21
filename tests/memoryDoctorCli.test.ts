import { expect, test } from "bun:test";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cagent-memory-doctor-cli-"));
}

async function fileExists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

async function runMemoryCheck(cwd: string): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
}> {
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", cliPath, "--memory-check"],
		{ cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	const completed = Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			completed,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					child.kill();
					reject(new Error("Timed out waiting for --memory-check"));
				}, 8_000);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
		if (child.exitCode === null) {
			child.kill();
		}
		await child.exited.catch(() => undefined);
	}
}

test("--memory-check exposes stable exit codes without initializing services", async () => {
	const cleanCwd = await makeTempDir();
	const issueCwd = await makeTempDir();
	const fatalCwd = await makeTempDir();
	try {
		const cleanControlDir = join(cleanCwd, ".cagent");
		const cleanMemoryDir = join(cleanControlDir, "memory");
		const mcpPath = join(cleanControlDir, "mcp.json");
		const topicPath = join(cleanMemoryDir, "healthy.md");
		const indexPath = join(cleanMemoryDir, "MEMORY.md");
		const topic = [
			"---",
			"type: project",
			"description: Healthy project convention",
			"created_at: 2026-07-21T00:00:00.000Z",
			"updated_at: 2026-07-21T00:00:00.000Z",
			"source: user",
			"confidence: high",
			"stability: evolving",
			"---",
			"",
			"Keep this convention.",
		].join("\n");
		const index =
			"# Memory\n\n- [Healthy project convention](healthy.md) (project, evolving)\n";
		await mkdir(cleanMemoryDir, { recursive: true });
		await Promise.all([
			writeFile(mcpPath, "not valid json", "utf8"),
			writeFile(topicPath, topic, "utf8"),
			writeFile(indexPath, index, "utf8"),
		]);
		const mcpMtimeNs = (await stat(mcpPath, { bigint: true })).mtimeNs;
		const clean = await runMemoryCheck(cleanCwd);
		expect(clean.exitCode).toBe(0);
		expect(clean.stdout).toContain("Memory check: OK");
		expect(clean.stdout).toContain("Store: present");
		expect(clean.stdout).toContain("Topics: 1");
		expect(clean.stderr).toBe("");
		expect((await readdir(cleanControlDir)).sort()).toEqual([
			"mcp.json",
			"memory",
		]);
		expect((await readdir(cleanMemoryDir)).sort()).toEqual([
			"MEMORY.md",
			"healthy.md",
		]);
		expect(await readFile(mcpPath, "utf8")).toBe("not valid json");
		expect((await stat(mcpPath, { bigint: true })).mtimeNs).toBe(mcpMtimeNs);
		expect(await readFile(topicPath, "utf8")).toBe(topic);
		expect(await readFile(indexPath, "utf8")).toBe(index);
		expect(
			await fileExists(join(cleanMemoryDir, ".mutation-lock.sqlite")),
		).toBe(false);

		await mkdir(join(issueCwd, ".cagent", "memory"), { recursive: true });
		const issue = await runMemoryCheck(issueCwd);
		expect(issue.exitCode).toBe(1);
		expect(issue.stdout).toContain("Memory check: ISSUES FOUND");
		expect(issue.stdout).toContain("index_missing MEMORY.md");
		expect(issue.stderr).toBe("");
		expect(
			await fileExists(
				join(issueCwd, ".cagent", "memory", ".mutation-lock.sqlite"),
			),
		).toBe(false);

		await mkdir(join(fatalCwd, ".cagent"), { recursive: true });
		await writeFile(
			join(fatalCwd, ".cagent", "memory"),
			"not a directory",
			"utf8",
		);
		const fatal = await runMemoryCheck(fatalCwd);
		expect(fatal.exitCode).toBe(2);
		expect(fatal.stdout).toBe("");
		expect(fatal.stderr).toContain("Memory check failed:");
	} finally {
		await Promise.all(
			[cleanCwd, issueCwd, fatalCwd].map((cwd) =>
				rm(cwd, { recursive: true, force: true }),
			),
		);
	}
}, 35_000);
