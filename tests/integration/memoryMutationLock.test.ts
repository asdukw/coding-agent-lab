import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	access,
	mkdtemp,
	open,
	readdir,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureMemoryStore,
	getMemoryDir,
	getMemoryIndexPath,
	validateMemoryStore,
	writeValidatedMemoryFile,
} from "../../src/memory";

type PipedChild = Bun.Subprocess<"ignore", "pipe", "pipe">;

type WorkerOutput = {
	status: "success" | "conflict" | "failure";
	message?: string;
};

const memoryEditWorkerPath = join(
	import.meta.dir,
	"..",
	"fixtures",
	"memory-edit-worker.ts",
);
const memoryWriteWorkerPath = join(
	import.meta.dir,
	"..",
	"fixtures",
	"memory-write-worker.ts",
);
const memoryLockHolderPath = join(
	import.meta.dir,
	"..",
	"fixtures",
	"memory-lock-holder.ts",
);

async function fileExists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

async function waitForFiles(paths: string[]): Promise<void> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const ready = await Promise.all(paths.map(fileExists));
		if (ready.every(Boolean)) {
			return;
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for files: ${paths.join(", ")}`);
		}
		await Bun.sleep(10);
	}
}

async function collectWorker(child: PipedChild): Promise<WorkerOutput> {
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`Memory worker exited with ${exitCode}: ${stderr}`);
	}
	return JSON.parse(stdout.trim()) as WorkerOutput;
}

async function stopChildren(children: PipedChild[]): Promise<void> {
	for (const child of children) {
		if (child.exitCode === null) {
			child.kill();
		}
	}
	await Promise.allSettled(children.map((child) => child.exited));
}

function spawnWriteWorker(params: {
	processCwd: string;
	memoryCwd: string;
	topicPath: string;
	contentPath: string;
	gatePath: string;
	readyPath: string;
}): PipedChild {
	return Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			memoryWriteWorkerPath,
			params.memoryCwd,
			params.topicPath,
			params.contentPath,
			params.gatePath,
			params.readyPath,
		],
		{
			cwd: params.processCwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
}

function memoryContent(description: string, body: string): string {
	return [
		"---",
		"type: project",
		`description: ${description}`,
		"created_at: 2026-07-21T00:00:00.000Z",
		"updated_at: 2026-07-21T00:00:00.000Z",
		"source: user",
		"confidence: high",
		"stability: evolving",
		"---",
		"",
		body,
	].join("\n");
}

async function corruptDatabaseBtreePage(lockPath: string): Promise<void> {
	const database = new Database(lockPath, { create: false, strict: true });
	let rootPage: number;
	let pageSize: number;
	try {
		database.exec(
			"CREATE TABLE corruption_probe (id INTEGER PRIMARY KEY, value TEXT)",
		);
		database.exec(
			"INSERT INTO corruption_probe (value) VALUES ('integrity probe')",
		);
		const root = database
			.query<{ rootpage: number }, [string]>(
				"SELECT rootpage FROM sqlite_schema WHERE name = ?",
			)
			.get("corruption_probe");
		const page = database
			.query<{ page_size: number }, []>("PRAGMA page_size")
			.get();
		if (!root || !page || root.rootpage <= 1 || page.page_size <= 0) {
			throw new Error("Could not locate a SQLite b-tree page to corrupt");
		}
		rootPage = root.rootpage;
		pageSize = page.page_size;
	} finally {
		database.close();
	}

	const handle = await open(lockPath, "r+");
	try {
		await handle.write(Uint8Array.of(0xff), 0, 1, (rootPage - 1) * pageSize);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

test("independent Bun processes serialize edits to the same memory topic", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-memory-process-"));
	const children: PipedChild[] = [];
	try {
		await ensureMemoryStore(cwd);
		const topicPath = join(cwd, ".cagent", "memory", "shared.md");
		const gatePath = join(cwd, "start-edit");
		const readyPaths = [join(cwd, "ready-a"), join(cwd, "ready-b")];
		await writeValidatedMemoryFile(
			cwd,
			topicPath,
			memoryContent("Original process convention", "Shared across processes."),
		);

		for (const readyPath of readyPaths) {
			children.push(
				Bun.spawn(
					[
						process.execPath,
						"--no-env-file",
						memoryEditWorkerPath,
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
		const outputs = await Promise.all(children.map(collectWorker));

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
		await stopChildren(children);
		await rm(cwd, { recursive: true, force: true });
	}
}, 15_000);

test("an abnormal lock-holder exit releases the SQLite mutation lock", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-memory-crash-"));
	const children: PipedChild[] = [];
	try {
		await ensureMemoryStore(cwd);
		await writeValidatedMemoryFile(
			cwd,
			join(getMemoryDir(cwd), "existing.md"),
			memoryContent("Existing convention", "Existing body."),
		);
		const lockPath = join(getMemoryDir(cwd), ".mutation-lock.sqlite");
		const holderReadyPath = join(cwd, "holder-ready");
		const holder = Bun.spawn(
			[
				process.execPath,
				"--no-env-file",
				memoryLockHolderPath,
				lockPath,
				holderReadyPath,
			],
			{ cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		children.push(holder);
		await waitForFiles([holderReadyPath]);
		holder.kill("SIGKILL");
		await holder.exited;

		const contentPath = join(cwd, "after-crash.txt");
		const gatePath = join(cwd, "write-after-crash");
		const workerReadyPath = join(cwd, "writer-ready");
		const topicPath = join(getMemoryDir(cwd), "after-crash.md");
		await writeFile(
			contentPath,
			memoryContent("Recovered lock convention", "Written after a crash."),
			"utf8",
		);
		await writeFile(gatePath, "start", "utf8");
		const writer = spawnWriteWorker({
			processCwd: cwd,
			memoryCwd: cwd,
			topicPath,
			contentPath,
			gatePath,
			readyPath: workerReadyPath,
		});
		children.push(writer);
		await waitForFiles([workerReadyPath]);
		const output = await collectWorker(writer);
		expect(output.status).toBe("success");
		expect(await readFile(topicPath, "utf8")).toContain(
			"Recovered lock convention",
		);
	} finally {
		await stopChildren(children);
		await rm(cwd, { recursive: true, force: true });
	}
}, 15_000);

test("a corrupted mutation database fails closed without writing memory", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-memory-corrupt-lock-"));
	const children: PipedChild[] = [];
	try {
		await ensureMemoryStore(cwd);
		const existingPath = join(getMemoryDir(cwd), "existing.md");
		await writeValidatedMemoryFile(
			cwd,
			existingPath,
			memoryContent("Existing safe convention", "Existing safe body."),
		);
		const lockPath = join(getMemoryDir(cwd), ".mutation-lock.sqlite");
		const beforeIndex = await readFile(getMemoryIndexPath(cwd), "utf8");
		const beforeExisting = await readFile(existingPath, "utf8");
		await corruptDatabaseBtreePage(lockPath);

		const contentPath = join(cwd, "blocked-content.txt");
		const gatePath = join(cwd, "start-blocked-write");
		const readyPath = join(cwd, "blocked-writer-ready");
		const topicPath = join(getMemoryDir(cwd), "must-not-exist.md");
		await writeFile(
			contentPath,
			memoryContent("Blocked convention", "This must not be written."),
			"utf8",
		);
		const worker = spawnWriteWorker({
			processCwd: cwd,
			memoryCwd: cwd,
			topicPath,
			contentPath,
			gatePath,
			readyPath,
		});
		children.push(worker);
		await waitForFiles([readyPath]);
		await writeFile(gatePath, "start", "utf8");
		const output = await collectWorker(worker);

		expect(output.status).toBe("failure");
		expect(output.message).toContain(
			"Memory mutation database failed integrity check",
		);
		await expect(readFile(topicPath, "utf8")).rejects.toThrow();
		expect(await readFile(existingPath, "utf8")).toBe(beforeExisting);
		expect(await readFile(getMemoryIndexPath(cwd), "utf8")).toBe(beforeIndex);
	} finally {
		await stopChildren(children);
		await rm(cwd, { recursive: true, force: true });
	}
}, 15_000);

test("independent writers cannot create duplicate memory descriptions", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-memory-duplicate-"));
	const children: PipedChild[] = [];
	try {
		await ensureMemoryStore(cwd);
		const gatePath = join(cwd, "start-duplicate-writes");
		const contenders = [
			{
				topicPath: join(getMemoryDir(cwd), "0.md"),
				contentPath: join(cwd, "a.txt"),
				readyPath: join(cwd, "ready-a"),
				body: "Body from process A.",
			},
			{
				topicPath: join(getMemoryDir(cwd), "1.md"),
				contentPath: join(cwd, "b.txt"),
				readyPath: join(cwd, "ready-b"),
				body: "Body from process B.",
			},
		];
		await Promise.all(
			contenders.map((contender) =>
				writeFile(
					contender.contentPath,
					memoryContent("Shared process description", contender.body),
					"utf8",
				),
			),
		);
		for (const contender of contenders) {
			children.push(
				spawnWriteWorker({
					processCwd: cwd,
					memoryCwd: cwd,
					topicPath: contender.topicPath,
					contentPath: contender.contentPath,
					gatePath,
					readyPath: contender.readyPath,
				}),
			);
		}

		await waitForFiles(contenders.map((contender) => contender.readyPath));
		await writeFile(gatePath, "start", "utf8");
		const outputs = await Promise.all(children.map(collectWorker));
		expect(outputs.map((output) => output.status).sort()).toEqual([
			"failure",
			"success",
		]);
		expect(
			outputs.find((output) => output.status === "failure")?.message,
		).toContain("duplicates existing memory description");
		const candidateExists = await Promise.all(
			contenders.map((contender) => fileExists(contender.topicPath)),
		);
		expect(candidateExists.filter(Boolean)).toHaveLength(1);
		expect(await validateMemoryStore(cwd)).toEqual([]);
		const index = await readFile(getMemoryIndexPath(cwd), "utf8");
		expect((index.match(/Shared process description/g) ?? []).length).toBe(1);
	} finally {
		await stopChildren(children);
		await rm(cwd, { recursive: true, force: true });
	}
}, 15_000);

test("independent writers cannot race past the memory file capacity", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-memory-capacity-"));
	const children: PipedChild[] = [];
	try {
		await ensureMemoryStore(cwd);
		const memoryDir = getMemoryDir(cwd);
		await Promise.all(
			Array.from({ length: 198 }, (_, index) =>
				writeFile(
					join(memoryDir, `seed-${index}.md`),
					memoryContent(`Seed convention ${index}`, `Seed body ${index}.`),
					"utf8",
				),
			),
		);

		const gatePath = join(cwd, "start-capacity-writes");
		const contenders = [
			{
				topicPath: join(memoryDir, "candidate-0.md"),
				contentPath: join(cwd, "candidate-a.txt"),
				readyPath: join(cwd, "ready-a"),
				description: "Capacity candidate A",
				body: "Capacity body A.",
			},
			{
				topicPath: join(memoryDir, "candidate-1.md"),
				contentPath: join(cwd, "candidate-b.txt"),
				readyPath: join(cwd, "ready-b"),
				description: "Capacity candidate B",
				body: "Capacity body B.",
			},
		];
		await Promise.all(
			contenders.map((contender) =>
				writeFile(
					contender.contentPath,
					memoryContent(contender.description, contender.body),
					"utf8",
				),
			),
		);
		for (const contender of contenders) {
			children.push(
				spawnWriteWorker({
					processCwd: cwd,
					memoryCwd: cwd,
					topicPath: contender.topicPath,
					contentPath: contender.contentPath,
					gatePath,
					readyPath: contender.readyPath,
				}),
			);
		}

		await waitForFiles(contenders.map((contender) => contender.readyPath));
		await writeFile(gatePath, "start", "utf8");
		const outputs = await Promise.all(children.map(collectWorker));
		expect(outputs.map((output) => output.status).sort()).toEqual([
			"failure",
			"success",
		]);
		expect(
			outputs.find((output) => output.status === "failure")?.message,
		).toContain("memory store has reached its 200-file limit");
		const markdownFiles = (await readdir(memoryDir)).filter((name) =>
			name.toLowerCase().endsWith(".md"),
		);
		expect(markdownFiles).toHaveLength(200);
		const candidateExists = await Promise.all(
			contenders.map((contender) => fileExists(contender.topicPath)),
		);
		expect(candidateExists.filter(Boolean)).toHaveLength(1);
		const index = await readFile(getMemoryIndexPath(cwd), "utf8");
		expect((index.match(/Capacity candidate [AB]/g) ?? []).length).toBe(1);
		expect(await validateMemoryStore(cwd)).toEqual([]);
	} finally {
		await stopChildren(children);
		await rm(cwd, { recursive: true, force: true });
	}
}, 30_000);

test("directory symlink or junction cwd aliases share the canonical mutation lock", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-memory-dir-alias-"));
	const aliasCwd = `${cwd}-alias`;
	const children: PipedChild[] = [];
	try {
		await ensureMemoryStore(cwd);
		await writeValidatedMemoryFile(
			cwd,
			join(getMemoryDir(cwd), "existing.md"),
			memoryContent("Existing directory alias", "Existing alias body."),
		);
		await symlink(
			cwd,
			aliasCwd,
			process.platform === "win32" ? "junction" : "dir",
		);

		const holderReadyPath = join(cwd, "dir-alias-holder-ready");
		const holder = Bun.spawn(
			[
				process.execPath,
				"--no-env-file",
				memoryLockHolderPath,
				join(getMemoryDir(cwd), ".mutation-lock.sqlite"),
				holderReadyPath,
			],
			{ cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		children.push(holder);
		await waitForFiles([holderReadyPath]);

		const gatePath = join(cwd, "start-dir-alias-write");
		const readyPath = join(cwd, "dir-alias-writer-ready");
		const contentPath = join(cwd, "dir-alias-content.txt");
		const aliasTopicPath = join(getMemoryDir(aliasCwd), "through-alias.md");
		await writeFile(
			contentPath,
			memoryContent("Directory alias convention", "Directory alias body."),
			"utf8",
		);
		const writer = spawnWriteWorker({
			processCwd: aliasCwd,
			memoryCwd: aliasCwd,
			topicPath: aliasTopicPath,
			contentPath,
			gatePath,
			readyPath,
		});
		children.push(writer);
		await waitForFiles([readyPath]);
		await writeFile(gatePath, "start", "utf8");
		const stateWhileLocked = await Promise.race([
			writer.exited.then(() => "exited" as const),
			Bun.sleep(250).then(() => "waiting" as const),
		]);
		expect(stateWhileLocked).toBe("waiting");

		holder.kill("SIGKILL");
		await holder.exited;
		const output = await collectWorker(writer);
		expect(output.status).toBe("success");
		expect(
			await readFile(join(getMemoryDir(cwd), "through-alias.md"), "utf8"),
		).toContain("Directory alias convention");
		expect(await validateMemoryStore(cwd)).toEqual([]);
	} finally {
		await stopChildren(children);
		await unlink(aliasCwd).catch(() => undefined);
		await rm(cwd, { recursive: true, force: true });
	}
}, 15_000);

test("Windows cwd case aliases share one cross-process mutation lock", async () => {
	if (process.platform !== "win32") {
		return;
	}

	const cwd = await mkdtemp(join(tmpdir(), "cagent-memory-cwd-alias-"));
	const children: PipedChild[] = [];
	try {
		await ensureMemoryStore(cwd);
		const aliasCwd = cwd.toUpperCase();
		await writeValidatedMemoryFile(
			cwd,
			join(getMemoryDir(cwd), "existing.md"),
			memoryContent("Existing alias convention", "Existing alias body."),
		);
		const holderReadyPath = join(cwd, "alias-holder-ready");
		const holder = Bun.spawn(
			[
				process.execPath,
				"--no-env-file",
				memoryLockHolderPath,
				join(getMemoryDir(cwd), ".mutation-lock.sqlite"),
				holderReadyPath,
			],
			{ cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		children.push(holder);
		await waitForFiles([holderReadyPath]);

		const gatePath = join(cwd, "start-alias-write");
		const readyPath = join(cwd, "alias-writer-ready");
		const contentPath = join(cwd, "alias-content.txt");
		const topicPath = join(getMemoryDir(aliasCwd), "upper.md");
		await writeFile(
			contentPath,
			memoryContent("Aliased process convention", "Alias body."),
			"utf8",
		);
		const writer = spawnWriteWorker({
			processCwd: aliasCwd,
			memoryCwd: aliasCwd,
			topicPath,
			contentPath,
			gatePath,
			readyPath,
		});
		children.push(writer);
		await waitForFiles([readyPath]);
		await writeFile(gatePath, "start", "utf8");
		const stateWhileLocked = await Promise.race([
			writer.exited.then(() => "exited" as const),
			Bun.sleep(250).then(() => "waiting" as const),
		]);
		expect(stateWhileLocked).toBe("waiting");

		holder.kill("SIGKILL");
		await holder.exited;
		const output = await collectWorker(writer);
		expect(output.status).toBe("success");
		expect(await readFile(topicPath, "utf8")).toContain(
			"Aliased process convention",
		);
		expect(await validateMemoryStore(cwd)).toEqual([]);
	} finally {
		await stopChildren(children);
		await rm(cwd, { recursive: true, force: true });
	}
}, 15_000);
