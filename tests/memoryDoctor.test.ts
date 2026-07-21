import { expect, test } from "bun:test";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkMemoryStore,
	getMemoryDir,
	getMemoryIndexPath,
	MAX_MEMORY_TOPIC_BYTES,
	type MemoryCheckReport,
} from "../src/memory";
import {
	formatMemoryCheckReport,
	runMemoryCheckCommand,
} from "../src/memoryDoctor";

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cagent-memory-doctor-"));
}

async function fileExists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

function memoryContent(params: {
	description: string;
	body: string;
	stability?: "temporary" | "evolving" | "durable";
	ttl?: string;
}): string {
	return [
		"---",
		"type: project",
		`description: ${params.description}`,
		"created_at: 2026-07-21T00:00:00.000Z",
		"updated_at: 2026-07-21T00:00:00.000Z",
		"source: user",
		"confidence: high",
		`stability: ${params.stability ?? "evolving"}`,
		...(params.ttl ? [`ttl: ${params.ttl}`] : []),
		"---",
		"",
		params.body,
	].join("\n");
}

function emptyReport(cwd: string): MemoryCheckReport {
	return {
		version: 1,
		cwd,
		memoryDir: getMemoryDir(cwd),
		indexPath: getMemoryIndexPath(cwd),
		storeExists: false,
		complete: true,
		topicCount: 0,
		expiredCount: 0,
		issues: [],
	};
}

test("memory check leaves a missing store uninitialized", async () => {
	const cwd = await makeTempDir();
	try {
		const controlDir = join(cwd, ".cagent");
		expect(await fileExists(controlDir)).toBe(false);

		const report = await checkMemoryStore(cwd);

		expect(report).toEqual(emptyReport(cwd));
		expect(await fileExists(controlDir)).toBe(false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory check does not modify a healthy store", async () => {
	const cwd = await makeTempDir();
	try {
		const memoryDir = getMemoryDir(cwd);
		const topicPath = join(memoryDir, "healthy.md");
		await mkdir(memoryDir, { recursive: true });
		await writeFile(
			topicPath,
			memoryContent({
				description: "Healthy project convention",
				body: "Keep this convention.",
			}),
			"utf8",
		);
		await writeFile(
			getMemoryIndexPath(cwd),
			"# Memory\n\n- [Healthy project convention](healthy.md) (project, evolving)\n",
			"utf8",
		);
		expect(await fileExists(join(memoryDir, ".mutation-lock.sqlite"))).toBe(
			false,
		);
		const entries = (await readdir(memoryDir)).sort();
		const before = await Promise.all(
			entries.map(async (entry) => {
				const path = join(memoryDir, entry);
				return {
					entry,
					content: await readFile(path),
					mtimeNs: (await stat(path, { bigint: true })).mtimeNs,
				};
			}),
		);

		const report = await checkMemoryStore(cwd);

		expect(report.storeExists).toBe(true);
		expect(report.complete).toBe(true);
		expect(report.topicCount).toBe(1);
		expect(report.issues).toEqual([]);
		expect((await readdir(memoryDir)).sort()).toEqual(entries);
		for (const snapshot of before) {
			const path = join(memoryDir, snapshot.entry);
			expect(await readFile(path)).toEqual(snapshot.content);
			expect((await stat(path, { bigint: true })).mtimeNs).toBe(
				snapshot.mtimeNs,
			);
		}
		expect(await fileExists(join(memoryDir, ".mutation-lock.sqlite"))).toBe(
			false,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory check reports governance issues with stable codes", async () => {
	const cwd = await makeTempDir();
	try {
		const memoryDir = getMemoryDir(cwd);
		await mkdir(join(memoryDir, "nested"), { recursive: true });
		await Promise.all([
			writeFile(join(memoryDir, "invalid.md"), "invalid", "utf8"),
			writeFile(
				join(memoryDir, "expired.md"),
				memoryContent({
					description: "Expired convention",
					body: "Expired body.",
					stability: "temporary",
					ttl: "2026-01-01T00:00:00.000Z",
				}),
				"utf8",
			),
			writeFile(
				join(memoryDir, "description-a.md"),
				memoryContent({
					description: "Shared process rule",
					body: "Description body A.",
				}),
				"utf8",
			),
			writeFile(
				join(memoryDir, "description-b.md"),
				memoryContent({
					description: "shared   process rule",
					body: "Description body B.",
				}),
				"utf8",
			),
			writeFile(
				join(memoryDir, "content-a.md"),
				memoryContent({
					description: "Content rule A",
					body: "Same   BODY.",
				}),
				"utf8",
			),
			writeFile(
				join(memoryDir, "content-b.md"),
				memoryContent({
					description: "Content rule B",
					body: "same body.",
				}),
				"utf8",
			),
			writeFile(
				join(memoryDir, "oversized.md"),
				`${memoryContent({
					description: "Oversized convention",
					body: "Oversized body.",
				})}\n${"x".repeat(MAX_MEMORY_TOPIC_BYTES)}`,
				"utf8",
			),
			writeFile(
				join(memoryDir, "nested", "MEMORY.md"),
				"# Misplaced index\n",
				"utf8",
			),
			writeFile(getMemoryIndexPath(cwd), "# Memory\n\n- stale entry\n", "utf8"),
		]);

		const report = await checkMemoryStore(
			cwd,
			new Date("2026-07-21T00:00:00.000Z"),
		);
		const codes = new Set(report.issues.map((issue) => issue.code));

		expect(report.complete).toBe(true);
		expect(report.topicCount).toBe(7);
		expect(report.expiredCount).toBe(1);
		for (const code of [
			"invalid_frontmatter",
			"topic_oversized",
			"topic_expired",
			"duplicate_description",
			"duplicate_content",
			"index_misplaced",
			"index_drift",
		] as const) {
			expect(codes.has(code)).toBe(true);
		}
		expect(report.issues).toContainEqual({
			code: "duplicate_description",
			severity: "error",
			path: "description-b.md",
			message: "duplicates existing memory description in description-a.md",
			action: "Review and merge this topic with description-a.md.",
		});
		expect(report.issues).toContainEqual({
			code: "duplicate_content",
			severity: "error",
			path: "content-b.md",
			message: "duplicates existing memory content in content-a.md",
			action: "Review and merge this topic with content-a.md.",
		});
		expect(report.issues).toContainEqual(
			expect.objectContaining({
				code: "index_misplaced",
				severity: "error",
				path: "nested/MEMORY.md",
			}),
		);
		expect(report.issues.every((issue) => issue.action.length > 0)).toBe(true);
		expect(report.issues.every((issue) => !issue.path.includes("\\"))).toBe(
			true,
		);
		const ordering = report.issues.map(
			(issue) => `${issue.path}\0${issue.code}\0${issue.message}`,
		);
		expect(ordering).toEqual(
			[...ordering].sort((left, right) => left.localeCompare(right)),
		);
		expect(await readFile(getMemoryIndexPath(cwd), "utf8")).toBe(
			"# Memory\n\n- stale entry\n",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory check distinguishes a missing index from a missing store", async () => {
	const cwd = await makeTempDir();
	try {
		await mkdir(getMemoryDir(cwd), { recursive: true });
		await writeFile(
			join(getMemoryDir(cwd), "topic.md"),
			memoryContent({
				description: "Topic without index",
				body: "Topic body.",
			}),
			"utf8",
		);

		const report = await checkMemoryStore(cwd);

		expect(report.storeExists).toBe(true);
		expect(report.complete).toBe(true);
		expect(report.issues).toContainEqual(
			expect.objectContaining({
				code: "index_missing",
				path: "MEMORY.md",
			}),
		);
		expect(await fileExists(getMemoryIndexPath(cwd))).toBe(false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory check follows the volume's actual index case semantics", async () => {
	const cwd = await makeTempDir();
	try {
		const memoryDir = getMemoryDir(cwd);
		await mkdir(memoryDir, { recursive: true });
		await writeFile(join(memoryDir, "memory.md"), "# Memory\n\n", "utf8");
		const canonicalNameResolves = await fileExists(getMemoryIndexPath(cwd));

		const report = await checkMemoryStore(cwd);

		expect(report.complete).toBe(true);
		if (canonicalNameResolves) {
			expect(report.issues).toEqual([]);
		} else {
			expect(new Set(report.issues.map((issue) => issue.code))).toEqual(
				new Set(["index_missing", "index_misplaced"]),
			);
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory check fails when the store path is not a safe directory", async () => {
	const base = await makeTempDir();
	const cwd = join(base, "workspace");
	const outside = join(base, "outside");
	const memoryPath = getMemoryDir(cwd);
	try {
		await mkdir(join(cwd, ".cagent"), { recursive: true });
		await mkdir(outside);
		await writeFile(memoryPath, "not a directory", "utf8");
		await expect(checkMemoryStore(cwd)).rejects.toThrow(
			"Memory path is not a directory",
		);
		await rm(memoryPath, { force: true });
		await symlink(
			outside,
			memoryPath,
			process.platform === "win32" ? "junction" : "dir",
		);
		await expect(checkMemoryStore(cwd)).rejects.toThrow();
	} finally {
		await unlink(memoryPath).catch(() => undefined);
		await rm(base, { recursive: true, force: true });
	}
});

test("memory check accepts a generated index larger than the prompt limit", async () => {
	const cwd = await makeTempDir();
	try {
		const memoryDir = getMemoryDir(cwd);
		const descriptionA = `A ${"a".repeat(12_600)}`;
		const descriptionB = `B ${"b".repeat(12_600)}`;
		const index = [
			"# Memory",
			"",
			`- [${descriptionA}](a.md) (project, evolving)`,
			`- [${descriptionB}](b.md) (project, evolving)`,
			"",
		].join("\n");
		await mkdir(memoryDir, { recursive: true });
		await Promise.all([
			writeFile(
				join(memoryDir, "a.md"),
				memoryContent({ description: descriptionA, body: "Body A." }),
				"utf8",
			),
			writeFile(
				join(memoryDir, "b.md"),
				memoryContent({ description: descriptionB, body: "Body B." }),
				"utf8",
			),
			writeFile(getMemoryIndexPath(cwd), index, "utf8"),
		]);
		expect(Buffer.byteLength(index, "utf8")).toBeGreaterThan(25_000);

		const report = await checkMemoryStore(cwd);

		expect(report.complete).toBe(true);
		expect(report.issues).toEqual([]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory check excludes expired topics from an otherwise current index", async () => {
	const cwd = await makeTempDir();
	try {
		const memoryDir = getMemoryDir(cwd);
		await mkdir(memoryDir, { recursive: true });
		await Promise.all([
			writeFile(
				join(memoryDir, "active.md"),
				memoryContent({
					description: "Active convention",
					body: "Active body.",
				}),
				"utf8",
			),
			writeFile(
				join(memoryDir, "expired.md"),
				memoryContent({
					description: "Expired convention",
					body: "Expired body.",
					stability: "temporary",
					ttl: "2026-01-01T00:00:00.000Z",
				}),
				"utf8",
			),
			writeFile(
				getMemoryIndexPath(cwd),
				"# Memory\n\n- [Active convention](active.md) (project, evolving)\n",
				"utf8",
			),
		]);

		const report = await checkMemoryStore(
			cwd,
			new Date("2026-07-21T00:00:00.000Z"),
		);

		expect(report.complete).toBe(true);
		expect(report.issues.map((issue) => issue.code)).toEqual(["topic_expired"]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("memory check refuses links inside the memory store", async () => {
	const base = await makeTempDir();
	const cwd = join(base, "workspace");
	const outside = join(base, "outside");
	const linkedDirectory = join(getMemoryDir(cwd), "linked");
	try {
		await mkdir(getMemoryDir(cwd), { recursive: true });
		await mkdir(outside);
		await symlink(
			outside,
			linkedDirectory,
			process.platform === "win32" ? "junction" : "dir",
		);

		await expect(checkMemoryStore(cwd)).rejects.toThrow(
			"refuses symbolic links or junctions",
		);
	} finally {
		await unlink(linkedDirectory).catch(() => undefined);
		await rm(base, { recursive: true, force: true });
	}
});

test("memory check command maps clean, issue, and fatal outcomes", async () => {
	const cwd = "C:/workspace";
	const clean = emptyReport(cwd);
	const cleanOutput: string[] = [];
	const cleanErrors: string[] = [];

	expect(
		await runMemoryCheckCommand({
			cwd,
			scan: async () => clean,
			writeOutput: (content) => cleanOutput.push(content),
			writeError: (content) => cleanErrors.push(content),
		}),
	).toBe(0);
	expect(formatMemoryCheckReport(clean)).toContain("Memory check: OK");
	expect(cleanErrors).toEqual([]);

	const issueReport: MemoryCheckReport = {
		...clean,
		storeExists: true,
		issues: [
			{
				code: "index_missing",
				severity: "error",
				path: "MEMORY.md",
				message: "The managed memory index is missing.",
				action: "Rebuild the index from topic frontmatter.",
			},
		],
	};
	const issueOutput: string[] = [];
	const issueErrors: string[] = [];
	expect(
		await runMemoryCheckCommand({
			cwd,
			scan: async () => issueReport,
			writeOutput: (content) => issueOutput.push(content),
			writeError: (content) => issueErrors.push(content),
		}),
	).toBe(1);
	expect(issueOutput).toHaveLength(1);
	expect(issueOutput[0]).toContain("index_missing MEMORY.md");
	expect(issueErrors).toEqual([]);

	const incompleteReport: MemoryCheckReport = {
		...clean,
		storeExists: true,
		complete: false,
		issues: [
			{
				code: "scan_concurrent_modification",
				severity: "error",
				path: ".",
				message: "Memory store changed while it was being scanned.",
				action:
					"Wait for memory mutations to finish, then run the check again.",
			},
		],
	};
	const incompleteOutput: string[] = [];
	const incompleteErrors: string[] = [];
	expect(
		await runMemoryCheckCommand({
			cwd,
			scan: async () => incompleteReport,
			writeOutput: (content) => incompleteOutput.push(content),
			writeError: (content) => incompleteErrors.push(content),
		}),
	).toBe(2);
	expect(incompleteOutput[0]).toContain("Memory check: INCOMPLETE");
	expect(incompleteOutput[0]).toContain("Scan: incomplete");
	expect(incompleteErrors).toEqual([]);

	const fatalOutput: string[] = [];
	const fatalErrors: string[] = [];
	expect(
		await runMemoryCheckCommand({
			cwd,
			scan: async () => {
				throw new Error("unsafe memory path");
			},
			writeOutput: (content) => fatalOutput.push(content),
			writeError: (content) => fatalErrors.push(content),
		}),
	).toBe(2);
	expect(fatalOutput).toEqual([]);
	expect(fatalErrors).toEqual(["Memory check failed: unsafe memory path\n"]);
});
