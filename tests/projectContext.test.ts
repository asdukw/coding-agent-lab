import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	buildBaseSystemPrompt,
	loadProjectContext,
	ProjectContextError,
} from "../src/projectContext";

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cagent-project-context-"));
}

test("loads hierarchical instructions with AGENTS.md preferred over CLAUDE.md", async () => {
	const workspaceRoot = await makeTempDir();
	const packageDir = join(workspaceRoot, "packages");
	const cwd = join(packageDir, "app");
	try {
		await mkdir(cwd, { recursive: true });
		await writeFile(join(workspaceRoot, "AGENTS.md"), "root agents");
		await writeFile(join(packageDir, "CLAUDE.md"), "package claude");
		await writeFile(join(cwd, "AGENTS.md"), "app agents");
		await writeFile(join(cwd, "CLAUDE.md"), "ignored app claude");

		const context = await loadProjectContext({ workspaceRoot, cwd });

		expect(context.workspaceRoot).toBe(resolve(workspaceRoot));
		expect(context.cwd).toBe(resolve(cwd));
		expect(
			context.instructions.map(({ source, content }) => ({ source, content })),
		).toEqual([
			{ source: "AGENTS.md", content: "root agents" },
			{ source: "CLAUDE.md", content: "package claude" },
			{ source: "AGENTS.md", content: "app agents" },
		]);
		expect(context.warnings).toEqual([]);
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true });
	}
});

test("rejects a cwd outside the normalized workspace root", async () => {
	const base = await makeTempDir();
	const workspaceRoot = join(base, "workspace");
	const outside = join(base, "outside");
	try {
		await mkdir(workspaceRoot);
		await mkdir(outside);

		const error = await loadProjectContext({
			workspaceRoot: join(workspaceRoot, "."),
			cwd: join(workspaceRoot, "..", "outside"),
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ProjectContextError);
		expect((error as ProjectContextError).code).toBe("CWD_OUTSIDE_WORKSPACE");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("rejects symlinked or reparse instruction paths instead of following them", async () => {
	const base = await makeTempDir();
	const workspaceRoot = join(base, "workspace");
	const outsideInstruction = join(base, "outside-instructions");
	try {
		await mkdir(workspaceRoot);
		await mkdir(outsideInstruction);
		await symlink(
			outsideInstruction,
			join(workspaceRoot, "AGENTS.md"),
			process.platform === "win32" ? "junction" : "dir",
		);

		const error = await loadProjectContext({
			workspaceRoot,
			cwd: workspaceRoot,
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ProjectContextError);
		expect((error as ProjectContextError).code).toBe("UNSAFE_PATH");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("rejects a symlink or junction in the directory chain", async () => {
	const base = await makeTempDir();
	const workspaceRoot = join(base, "workspace");
	const outside = join(base, "outside");
	const linkedDirectory = join(workspaceRoot, "linked");
	try {
		await mkdir(workspaceRoot);
		await mkdir(outside);
		await symlink(
			outside,
			linkedDirectory,
			process.platform === "win32" ? "junction" : "dir",
		);

		const error = await loadProjectContext({
			workspaceRoot,
			cwd: linkedDirectory,
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ProjectContextError);
		expect((error as ProjectContextError).code).toBe("UNSAFE_PATH");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("rejects a hard-linked project instruction", async () => {
	const base = await makeTempDir();
	const workspaceRoot = join(base, "workspace");
	const outsideInstruction = join(base, "outside.txt");
	try {
		await mkdir(workspaceRoot);
		await writeFile(outsideInstruction, "outside secret");
		await link(outsideInstruction, join(workspaceRoot, "AGENTS.md"));

		const error = await loadProjectContext({
			workspaceRoot,
			cwd: workspaceRoot,
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ProjectContextError);
		expect((error as ProjectContextError).code).toBe("UNSAFE_PATH");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("enforces per-file limits without falling back from an existing AGENTS.md", async () => {
	const workspaceRoot = await makeTempDir();
	try {
		await writeFile(join(workspaceRoot, "AGENTS.md"), "12345");
		await writeFile(join(workspaceRoot, "CLAUDE.md"), "ok");

		const context = await loadProjectContext({
			workspaceRoot,
			cwd: workspaceRoot,
			maxInstructionFileBytes: 4,
			maxInstructionTotalBytes: 20,
		});

		expect(context.instructions).toEqual([]);
		expect(context.warnings).toHaveLength(1);
		expect(context.warnings[0]).toContain("per-file limit of 4 bytes");
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true });
	}
});

test("keeps deeper instructions when the total byte budget is exhausted", async () => {
	const workspaceRoot = await makeTempDir();
	const middle = join(workspaceRoot, "middle");
	const cwd = join(middle, "cwd");
	try {
		await mkdir(cwd, { recursive: true });
		await writeFile(join(workspaceRoot, "AGENTS.md"), "root");
		await writeFile(join(middle, "AGENTS.md"), "middle");
		await writeFile(join(cwd, "AGENTS.md"), "deep");

		const context = await loadProjectContext({
			workspaceRoot,
			cwd,
			maxInstructionFileBytes: 10,
			maxInstructionTotalBytes: 10,
		});

		expect(context.instructions.map(({ content }) => content)).toEqual([
			"middle",
			"deep",
		]);
		expect(context.warnings).toHaveLength(1);
		expect(context.warnings[0]).toContain("lower-priority");
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true });
	}
});

test("builds a base prompt with boundaries, precedence, and final-summary rules", () => {
	const prompt = buildBaseSystemPrompt({
		workspaceRoot: "C:\\repo",
		cwd: "C:\\repo\\app",
		instructions: [
			{
				path: "C:\\repo\\AGENTS.md",
				source: "AGENTS.md",
				content: "parent instruction",
				sizeBytes: 18,
			},
			{
				path: "C:\\repo\\app\\CLAUDE.md",
				source: "CLAUDE.md",
				content: "child instruction",
				sizeBytes: 17,
			},
		],
		warnings: [],
	});

	const parentIndex = prompt.indexOf("parent instruction");
	const childIndex = prompt.indexOf("child instruction");
	expect(prompt).toContain('Workspace root: "C:\\\\repo"');
	expect(prompt).toContain('Current working directory: "C:\\\\repo\\\\app"');
	expect(prompt).toContain(
		"More deeply nested instructions have higher priority",
	);
	expect(prompt).toContain("Never read `.env`");
	expect(prompt).toContain("under a `.git` directory");
	expect(prompt).toContain("Summarize the files changed");
	expect(parentIndex).toBeGreaterThanOrEqual(0);
	expect(childIndex).toBeGreaterThan(parentIndex);
});
