import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { BigIntStats, Dirent } from "node:fs";
import {
	mkdir,
	open,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
	isPathInside,
	resolveContainedWritePath,
	resolveRealPathForWrite,
} from "./pathSafety";
import type { Message } from "./state";

export const MEMORY_DIR_NAME = "memory";
export const MEMORY_ENTRYPOINT_NAME = "MEMORY.md";

const DEFAULT_MEMORY_INDEX_CONTENT = "# Memory\n\n";
const MAX_MEMORY_INDEX_LINES = 200;
const MAX_MEMORY_INDEX_BYTES = 25_000;
const MAX_MEMORY_FILES = 200;
const FRONTMATTER_MAX_LINES = 40;
const FRONTMATTER_MAX_BYTES = 16_000;
export const MAX_MEMORY_TOPIC_BYTES = 256_000;
const MAX_RELEVANT_MEMORY_FILES = 5;
const MAX_RELEVANT_MEMORY_LINES = 200;
const MAX_RELEVANT_MEMORY_BYTES = 20_000;
const MEMORY_MUTATION_LOCK_NAME = ".mutation-lock.sqlite";
const MEMORY_MUTATION_LOCK_TIMEOUT_MS = 10_000;
const memoryMutationTails = new Map<string, Promise<void>>();
const MEMORY_FRONTMATTER_KEYS = new Set([
	"type",
	"description",
	"created_at",
	"updated_at",
	"source",
	"confidence",
	"stability",
	"ttl",
]);

export const MEMORY_TYPES = [
	"user",
	"feedback",
	"project",
	"reference",
] as const;
export const MEMORY_CONFIDENCES = ["low", "medium", "high"] as const;
export const MEMORY_STABILITIES = ["temporary", "evolving", "durable"] as const;
export const MEMORY_SOURCES = [
	"user",
	"assistant",
	"tool",
	"inferred",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number];
export type MemoryStability = (typeof MEMORY_STABILITIES)[number];
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export type MemoryMetadata = {
	type?: MemoryType;
	description?: string;
	createdAt?: string;
	updatedAt?: string;
	source?: MemorySource;
	confidence?: MemoryConfidence;
	stability?: MemoryStability;
	ttl?: string;
};

export type MemoryValidationIssue = {
	path: string;
	message: string;
};

type ParsedMemoryFrontmatter = {
	metadata: MemoryMetadata;
	issues: MemoryValidationIssue[];
};

export type MemoryStoreInfo = {
	memoryDir: string;
	indexPath: string;
	files: MemoryHeader[];
};

export type MemoryHeader = {
	filename: string;
	filePath: string;
	mtimeMs: number;
	sizeBytes: number;
	readFailure?: string;
	metadata: MemoryMetadata;
	validationIssues: MemoryValidationIssue[];
};

export type RelevantMemory = {
	path: string;
	content: string;
	mtimeMs: number;
	truncated: boolean;
};

type MemoryEditSnapshot = {
	targetPath: string;
	content: string;
	device: bigint;
	inode: bigint;
	size: bigint;
	mtimeNs: bigint;
};

export class MemoryEditConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryEditConflictError";
	}
}

export function getMemoryDir(cwd: string): string {
	return join(cwd, ".cagent", MEMORY_DIR_NAME);
}

export function getMemoryIndexPath(cwd: string): string {
	return join(getMemoryDir(cwd), MEMORY_ENTRYPOINT_NAME);
}

export async function ensureMemoryStore(cwd: string): Promise<MemoryStoreInfo> {
	const memoryDir = getMemoryDir(cwd);
	const indexPath = getMemoryIndexPath(cwd);

	await resolveContainedWritePath({
		targetPath: memoryDir,
		directoryPath: memoryDir,
		boundaryPath: cwd,
	});
	await mkdir(memoryDir, { recursive: true });
	await resolveContainedWritePath({
		targetPath: indexPath,
		directoryPath: memoryDir,
		boundaryPath: cwd,
	});
	try {
		await writeFile(indexPath, DEFAULT_MEMORY_INDEX_CONTENT, {
			encoding: "utf-8",
			flag: "wx",
		});
	} catch (caught) {
		if (!hasErrnoCode(caught, "EEXIST")) {
			throw caught;
		}
	}

	return {
		memoryDir,
		indexPath,
		files: await scanMemoryHeaders(memoryDir, await listMemoryFiles(memoryDir)),
	};
}

export async function refreshMemoryIndex(
	cwd: string,
): Promise<MemoryStoreInfo> {
	return withMemoryMutationLock(cwd, () => refreshMemoryIndexUnlocked(cwd));
}

async function refreshMemoryIndexUnlocked(
	cwd: string,
): Promise<MemoryStoreInfo> {
	const store = await ensureMemoryStore(cwd);
	const { memoryDir, indexPath } = store;
	const files = await scanMemoryHeaders(
		memoryDir,
		await listMemoryFiles(memoryDir),
	);
	const topicFiles = files.filter((file) => !isMemoryIndexPath(file.filename));
	const unreadable = topicFiles.find((file) => file.readFailure);
	if (unreadable) {
		throw new Error(
			`Cannot refresh memory index because ${unreadable.filename} is unreadable: ${unreadable.readFailure}`,
		);
	}
	await writeMemoryIndexAtomically(
		cwd,
		indexPath,
		formatMemoryIndex(topicFiles),
	);

	return {
		memoryDir,
		indexPath,
		files: await scanMemoryHeaders(memoryDir, await listMemoryFiles(memoryDir)),
	};
}

export async function validateMemoryStore(
	cwd: string,
): Promise<MemoryValidationIssue[]> {
	const info = await ensureMemoryStore(cwd);
	const topicFiles = info.files.filter(
		(file) => !isMemoryIndexPath(file.filename),
	);
	return [
		...topicFiles.flatMap((file) => file.validationIssues),
		...(await findDuplicateMemoryIssues(topicFiles)),
	];
}

export async function validateMemoryWrite(
	cwd: string,
	path: string,
	content: string,
): Promise<MemoryValidationIssue[]> {
	const issues = validateMemoryFile(path, content);
	if (issues.length > 0 || isMemoryIndexPath(path)) {
		return issues;
	}

	const parsed = parseFrontmatter(path, content);
	const candidateDescription = normalizeDuplicateKey(
		parsed.metadata.description ?? "",
	);
	const candidateBody = normalizeMemoryBody(content);
	const candidatePath = await resolveRealPathForWrite(resolve(cwd, path));
	const info = await ensureMemoryStore(cwd);
	let replacesExistingFile = false;

	for (const memory of info.files) {
		if (isMemoryIndexPath(memory.filename)) {
			continue;
		}
		if (
			sameCanonicalPath(
				await resolveRealPathForWrite(memory.filePath),
				candidatePath,
			)
		) {
			replacesExistingFile = true;
			continue;
		}
		if (memory.readFailure) {
			return [
				{
					path,
					message: `cannot deduplicate against unreadable memory ${memory.filename}: ${memory.readFailure}`,
				},
			];
		}
		if (memory.sizeBytes > MAX_MEMORY_TOPIC_BYTES) {
			return [
				{
					path,
					message: `cannot deduplicate against oversized memory ${memory.filename}`,
				},
			];
		}
		if (
			candidateDescription &&
			normalizeDuplicateKey(memory.metadata.description ?? "") ===
				candidateDescription
		) {
			return [
				{
					path,
					message: `duplicates existing memory description in ${memory.filename}`,
				},
			];
		}
		if (candidateBody) {
			const existing = await readMemoryBody(memory);
			if (normalizeMemoryBody(existing) === candidateBody) {
				return [
					{
						path,
						message: `duplicates existing memory content in ${memory.filename}`,
					},
				];
			}
		}
	}
	if (!replacesExistingFile && info.files.length >= MAX_MEMORY_FILES) {
		return [
			{
				path,
				message: `memory store has reached its ${MAX_MEMORY_FILES}-file limit`,
			},
		];
	}

	return [];
}

export async function resolveMemoryWriteTarget(
	cwd: string,
	path: string,
): Promise<string | undefined> {
	const targetPath = resolve(cwd, path);
	const memoryDir = getMemoryDir(cwd);

	if (isPathInside(targetPath, memoryDir)) {
		const safeTarget = await resolveContainedWritePath({
			targetPath,
			directoryPath: memoryDir,
			boundaryPath: cwd,
		});
		const canonicalTarget = await resolveRealPathForWrite(safeTarget);
		return canonicalTarget;
	}

	const [realCwd, realMemoryDir, realTarget] = await Promise.all([
		resolveRealPathForWrite(cwd),
		resolveRealPathForWrite(memoryDir),
		resolveRealPathForWrite(targetPath),
	]);
	if (!isPathInside(realMemoryDir, realCwd)) {
		if (isPathInside(realTarget, realMemoryDir)) {
			throw new Error(`Memory directory escapes the workspace: ${memoryDir}`);
		}
		return undefined;
	}
	if (isPathInside(realTarget, realMemoryDir)) {
		return resolveContainedWritePath({
			targetPath: realTarget,
			directoryPath: realMemoryDir,
			boundaryPath: realCwd,
		});
	}

	const hardlinkedMemoryTarget = await findHardlinkedMemoryTarget(
		realMemoryDir,
		realTarget,
	);
	if (!hardlinkedMemoryTarget) {
		return undefined;
	}
	return resolveContainedWritePath({
		targetPath: hardlinkedMemoryTarget,
		directoryPath: realMemoryDir,
		boundaryPath: realCwd,
	});
}

export async function writeValidatedMemoryFile(
	cwd: string,
	path: string,
	content: string,
): Promise<number> {
	return withMemoryMutationLock(cwd, async () => {
		const targetPath = await resolveMemoryWriteTarget(cwd, path);
		if (!targetPath) {
			throw new Error(`Path is outside the memory directory: ${path}`);
		}
		if (isMemoryIndexPath(targetPath)) {
			throw new Error("MEMORY.md is managed automatically after extraction");
		}
		const issues = await validateMemoryWrite(cwd, targetPath, content);
		if (issues.length > 0) {
			throw new Error(
				`Invalid memory file: ${issues.map((issue) => issue.message).join("; ")}`,
			);
		}

		await replaceMemoryFileAtomically(cwd, targetPath, content);
		await refreshMemoryIndexUnlocked(cwd);
		return Buffer.byteLength(content, "utf-8");
	});
}

export async function editValidatedMemoryFile(
	cwd: string,
	path: string,
	oldString: string,
	newString: string,
	replaceAll = false,
): Promise<{ replacements: number }> {
	return withMemoryMutationLock(cwd, async () => {
		const targetPath = await resolveMemoryWriteTarget(cwd, path);
		if (!targetPath) {
			throw new Error(`Path is outside the memory directory: ${path}`);
		}
		if (isMemoryIndexPath(targetPath)) {
			throw new Error("MEMORY.md is managed automatically after extraction");
		}

		const snapshot = await readMemoryEditSnapshot(targetPath);
		const occurrences = countExactOccurrences(snapshot.content, oldString);
		if (occurrences === 0) {
			throw new MemoryEditConflictError(
				`Memory edit conflict: old_string not found in ${path}; the file may have changed`,
			);
		}
		if (!replaceAll && occurrences > 1) {
			throw new Error(
				`old_string matched ${occurrences} times in ${path}; pass replace_all or make old_string unique`,
			);
		}

		const replacements = replaceAll ? occurrences : 1;
		const updated = replaceAll
			? snapshot.content.split(oldString).join(newString)
			: snapshot.content.replace(oldString, newString);
		const issues = await validateMemoryWrite(cwd, targetPath, updated);
		if (issues.length > 0) {
			throw new Error(
				`Invalid memory file: ${issues.map((issue) => issue.message).join("; ")}`,
			);
		}

		await assertMemoryEditSnapshotUnchanged(snapshot);
		await replaceMemoryFileAtomically(cwd, targetPath, updated);
		await refreshMemoryIndexUnlocked(cwd);
		return { replacements };
	});
}

function countExactOccurrences(content: string, search: string): number {
	return content.split(search).length - 1;
}

async function readMemoryEditSnapshot(
	targetPath: string,
): Promise<MemoryEditSnapshot> {
	const before = await stat(targetPath, { bigint: true });
	const result = await readTextPrefix(targetPath, MAX_MEMORY_TOPIC_BYTES);
	const after = await stat(targetPath, { bigint: true });
	if (result.truncated) {
		throw new Error(
			`Memory topic files must not exceed ${MAX_MEMORY_TOPIC_BYTES} bytes`,
		);
	}
	if (!sameMemoryFileVersion(before, after)) {
		throw new MemoryEditConflictError(
			`Memory edit conflict: ${targetPath} changed while it was being read`,
		);
	}
	return {
		targetPath,
		content: result.content,
		device: after.dev,
		inode: after.ino,
		size: after.size,
		mtimeNs: after.mtimeNs,
	};
}

async function assertMemoryEditSnapshotUnchanged(
	snapshot: MemoryEditSnapshot,
): Promise<void> {
	let current: MemoryEditSnapshot;
	try {
		current = await readMemoryEditSnapshot(snapshot.targetPath);
	} catch (caught) {
		if (caught instanceof MemoryEditConflictError) {
			throw caught;
		}
		throw new MemoryEditConflictError(
			`Memory edit conflict: ${snapshot.targetPath} could not be re-read before commit: ${caught instanceof Error ? caught.message : String(caught)}`,
		);
	}
	if (
		current.device !== snapshot.device ||
		current.inode !== snapshot.inode ||
		current.size !== snapshot.size ||
		current.mtimeNs !== snapshot.mtimeNs ||
		current.content !== snapshot.content
	) {
		throw new MemoryEditConflictError(
			`Memory edit conflict: ${snapshot.targetPath} changed before commit`,
		);
	}
}

function sameMemoryFileVersion(left: BigIntStats, right: BigIntStats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs
	);
}

export async function loadMemoryPrompt(cwd: string): Promise<string> {
	const info = await ensureMemoryStore(cwd);
	const rawIndex = await readTextPrefix(info.indexPath, MAX_MEMORY_INDEX_BYTES);
	const formattedIndex = formatMemoryIndexForPrompt(rawIndex.content);
	const index = rawIndex.truncated
		? `${formattedIndex}\n\n> MEMORY.md was truncated for prompt size. Read the file directly if more detail is needed.`
		: formattedIndex;

	return [
		"# cagent memory",
		"",
		`You have a persistent, file-based memory store at \`${info.memoryDir}\`.`,
		`The memory index is \`${info.indexPath}\`.`,
		"",
		"Use memory for stable cross-session knowledge only:",
		"- user preferences, role, background, or collaboration style",
		"- feedback about how to work with the user",
		"- project context that is not obvious from reading the current files",
		"- references to external systems or where to look things up",
		"",
		"Do not save ephemeral task state, TODOs, plan details, raw session summaries, git history, or code facts that can be derived from the repository.",
		"",
		"When the user explicitly asks you to remember or forget something, update the memory store immediately if current mode permissions allow file writes.",
		"Write memories as focused markdown topic files under the memory directory.",
		"Do not edit MEMORY.md directly; it is regenerated automatically from topic files.",
		"",
		"Every topic file must start with YAML frontmatter:",
		"```yaml",
		"---",
		"type: user | feedback | project | reference",
		"description: short human-readable summary",
		"created_at: ISO-8601 timestamp",
		"updated_at: ISO-8601 timestamp",
		"source: user | assistant | tool | inferred",
		"confidence: low | medium | high",
		"stability: temporary | evolving | durable",
		"ttl: optional ISO-8601 expiry timestamp for temporary memories",
		"---",
		"```",
		"",
		"Use stability=temporary only for information with a known expiry and include ttl. Use stability=evolving for preferences or project facts that may change. Use stability=durable for stable identity, workflow, or long-lived reference information.",
		"If a memory may be relevant, read MEMORY.md or the linked topic files before relying on it. Treat memory as potentially stale and verify file/function claims against the current repo before acting on them.",
		"In plan mode, do not write memory; wait until normal mode unless the user explicitly approves implementation.",
		"",
		`## ${MEMORY_ENTRYPOINT_NAME}`,
		"",
		index,
	].join("\n");
}

export function formatMemoryStoreSummary(info: MemoryStoreInfo): string {
	const files = info.files.length
		? info.files.map((file) => `- ${formatMemoryFileSummary(file)}`).join("\n")
		: "No memory files yet.";

	return [
		"Memory store is ready.",
		"",
		`Directory: ${info.memoryDir}`,
		`Index: ${info.indexPath}`,
		"",
		"Files:",
		files,
	].join("\n");
}

export async function scanMemoryFiles(cwd: string): Promise<MemoryHeader[]> {
	const info = await ensureMemoryStore(cwd);
	return info.files
		.filter((file) => !isMemoryIndexPath(file.filename))
		.filter((file) => !isMemoryExpired(file.metadata))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function formatMemoryManifest(memories: MemoryHeader[]): string {
	return memories
		.map((memory) => {
			const type = memory.metadata.type ? `[${memory.metadata.type}] ` : "";
			const modified =
				memory.metadata.updatedAt ?? new Date(memory.mtimeMs).toISOString();
			const stability = memory.metadata.stability
				? `; stability=${memory.metadata.stability}`
				: "";
			const ttl = memory.metadata.ttl ? `; ttl=${memory.metadata.ttl}` : "";
			const description = memory.metadata.description;
			return description
				? `- ${type}${memory.filename} (${modified}${stability}${ttl}): ${description}`
				: `- ${type}${memory.filename} (${modified}${stability}${ttl})`;
		})
		.join("\n");
}

export function validateMemoryFile(
	path: string,
	content: string,
): MemoryValidationIssue[] {
	if (isMemoryIndexPath(path)) {
		return [];
	}
	if (!path.replace(/\\/g, "/").toLowerCase().endsWith(".md")) {
		return [{ path, message: "memory topic files must use the .md extension" }];
	}
	const issues: MemoryValidationIssue[] = [];
	if (Buffer.byteLength(content, "utf-8") > MAX_MEMORY_TOPIC_BYTES) {
		issues.push({
			path,
			message: `memory topic files must not exceed ${MAX_MEMORY_TOPIC_BYTES} bytes`,
		});
	}
	const headerText = truncateUtf8String(content, FRONTMATTER_MAX_BYTES)
		.split("\n")
		.slice(0, FRONTMATTER_MAX_LINES)
		.join("\n");
	const parsed = parseFrontmatter(path, headerText);
	return [
		...issues,
		...parsed.issues,
		...validateMemoryMetadata(path, parsed.metadata),
	];
}

export function validateMemoryMetadata(
	path: string,
	metadata: MemoryMetadata,
): MemoryValidationIssue[] {
	const issues: MemoryValidationIssue[] = [];
	if (!metadata.type) {
		issues.push({ path, message: "missing type" });
	}
	if (!metadata.description) {
		issues.push({ path, message: "missing description" });
	}
	if (!metadata.createdAt) {
		issues.push({ path, message: "missing created_at" });
	}
	if (!metadata.updatedAt) {
		issues.push({ path, message: "missing updated_at" });
	}
	if (!metadata.source) {
		issues.push({ path, message: "missing source" });
	}
	if (!metadata.confidence) {
		issues.push({ path, message: "missing confidence" });
	}
	if (!metadata.stability) {
		issues.push({ path, message: "missing stability" });
	}
	if (metadata.createdAt && !isIsoDate(metadata.createdAt)) {
		issues.push({ path, message: "created_at must be an ISO-8601 timestamp" });
	}
	if (metadata.updatedAt && !isIsoDate(metadata.updatedAt)) {
		issues.push({ path, message: "updated_at must be an ISO-8601 timestamp" });
	}
	if (metadata.ttl && !isIsoDate(metadata.ttl)) {
		issues.push({ path, message: "ttl must be an ISO-8601 timestamp" });
	}
	if (metadata.stability === "temporary" && !metadata.ttl) {
		issues.push({ path, message: "temporary memories must include ttl" });
	}
	return issues;
}

export function isMemoryExpired(
	metadata: MemoryMetadata,
	now = new Date(),
): boolean {
	if (!metadata.ttl || !isIsoDate(metadata.ttl)) {
		return false;
	}
	return new Date(metadata.ttl).getTime() <= now.getTime();
}

export function buildMemorySelectionMessages(params: {
	userInput: string;
	manifest: string;
}): Message[] {
	return [
		{
			role: "system",
			content:
				'You select cagent memory files that are clearly useful for the user\'s current request. Be selective. Return only JSON with this exact shape: {"selected_memories":["relative/path.md"]}. Select at most 5 files. Return an empty array if no listed memory is clearly relevant.',
		},
		{
			role: "user",
			content: `User request:\n${params.userInput}\n\nAvailable memory files:\n${params.manifest}`,
		},
	];
}

export function parseSelectedMemoryFilenames(
	output: string,
	memories: MemoryHeader[],
): string[] {
	const available = new Set(memories.map((memory) => memory.filename));
	const selected = parseSelectedMemoryJson(output);
	if (!selected) {
		return [];
	}

	const unique: string[] = [];
	for (const filename of selected) {
		if (
			typeof filename === "string" &&
			available.has(filename) &&
			!unique.includes(filename)
		) {
			unique.push(filename);
		}
		if (unique.length >= MAX_RELEVANT_MEMORY_FILES) {
			break;
		}
	}
	return unique;
}

export async function readRelevantMemories(
	memories: MemoryHeader[],
	selectedFilenames: string[],
): Promise<RelevantMemory[]> {
	const byFilename = new Map(
		memories.map((memory) => [memory.filename, memory] as const),
	);

	const results = await Promise.allSettled(
		selectedFilenames.map(async (filename) => {
			const memory = byFilename.get(filename);
			if (!memory) {
				throw new Error(`unknown memory: ${filename}`);
			}

			const raw = await readTextPrefix(
				memory.filePath,
				MAX_RELEVANT_MEMORY_BYTES,
			);
			const formatted = truncateMemoryContent(raw.content);
			return {
				path: memory.filename,
				content: formatted.content,
				mtimeMs: memory.mtimeMs,
				truncated: raw.truncated || formatted.truncated,
			};
		}),
	);

	return results
		.filter((result): result is PromiseFulfilledResult<RelevantMemory> => {
			return result.status === "fulfilled";
		})
		.map((result) => result.value);
}

export function formatRelevantMemoriesPrompt(
	memories: RelevantMemory[],
): string {
	if (memories.length === 0) {
		return "";
	}

	const blocks = memories.map((memory) => {
		const truncated = memory.truncated
			? "\n\n> This memory was truncated. Read the memory file directly if more detail is needed."
			: "";
		return [
			`<memory path="${escapeAttribute(memory.path)}" modifiedAt="${new Date(memory.mtimeMs).toISOString()}">`,
			memory.content,
			truncated,
			"</memory>",
		].join("\n");
	});

	return [
		"# relevant memories",
		"",
		"The following memory files were selected as relevant to the current request. Treat them as potentially stale; verify file/function claims against the current repository before acting on them.",
		"",
		...blocks,
	].join("\n");
}

async function listMemoryFiles(memoryDir: string): Promise<string[]> {
	const files: string[] = [];

	async function walk(dir: string): Promise<void> {
		const entries: Dirent[] = await readdir(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
			} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				files.push(relative(memoryDir, fullPath).replace(/\\/g, "/"));
			}
		}
	}

	await walk(memoryDir);
	if (files.length > MAX_MEMORY_FILES) {
		throw new Error(
			`memory store contains ${files.length} markdown files; limit is ${MAX_MEMORY_FILES}`,
		);
	}
	return files.sort((a, b) => {
		if (isMemoryIndexPath(a)) {
			return -1;
		}
		if (isMemoryIndexPath(b)) {
			return 1;
		}
		return a.localeCompare(b);
	});
}

async function findHardlinkedMemoryTarget(
	memoryDir: string,
	targetPath: string,
): Promise<string | undefined> {
	let targetStat: Awaited<ReturnType<typeof stat>>;
	try {
		targetStat = await stat(targetPath, { bigint: true });
	} catch (caught) {
		if (hasErrnoCode(caught, "ENOENT") || hasErrnoCode(caught, "ENOTDIR")) {
			return undefined;
		}
		throw caught;
	}
	if (!targetStat.isFile() || targetStat.nlink < 2n) {
		return undefined;
	}
	if (targetStat.ino === 0n) {
		throw new Error(
			`Cannot safely classify hardlinked write target with no file identity: ${targetPath}`,
		);
	}

	let memoryFiles: string[];
	try {
		memoryFiles = await listMemoryFiles(memoryDir);
	} catch (caught) {
		if (hasErrnoCode(caught, "ENOENT") || hasErrnoCode(caught, "ENOTDIR")) {
			return undefined;
		}
		throw caught;
	}
	for (const filename of memoryFiles) {
		const memoryPath = join(memoryDir, filename);
		const memoryStat = await stat(memoryPath, { bigint: true });
		if (
			memoryStat.dev === targetStat.dev &&
			memoryStat.ino === targetStat.ino
		) {
			return resolveRealPathForWrite(memoryPath);
		}
	}
	return undefined;
}

async function scanMemoryHeaders(
	memoryDir: string,
	files: string[],
): Promise<MemoryHeader[]> {
	const selectedFiles = files.slice(0, MAX_MEMORY_FILES);
	const results = await Promise.allSettled(
		selectedFiles.map(async (filename) => {
			const filePath = join(memoryDir, filename);
			const [header, fileStat] = await Promise.all([
				readTextPrefix(filePath, FRONTMATTER_MAX_BYTES),
				stat(filePath),
			]);
			const headerText = header.content
				.split("\n")
				.slice(0, FRONTMATTER_MAX_LINES)
				.join("\n");
			const parsed = parseFrontmatter(filename, headerText);
			const sizeIssues: MemoryValidationIssue[] =
				fileStat.size > MAX_MEMORY_TOPIC_BYTES && !isMemoryIndexPath(filename)
					? [
							{
								path: filename,
								message: `memory topic files must not exceed ${MAX_MEMORY_TOPIC_BYTES} bytes`,
							},
						]
					: [];
			return {
				filename,
				filePath,
				mtimeMs: fileStat.mtimeMs,
				sizeBytes: fileStat.size,
				metadata: parsed.metadata,
				validationIssues: isMemoryIndexPath(filename)
					? []
					: [
							...sizeIssues,
							...parsed.issues,
							...validateMemoryMetadata(filename, parsed.metadata),
						],
			};
		}),
	);

	return results.map((result, index) => {
		if (result.status === "fulfilled") {
			return result.value;
		}
		const filename = selectedFiles[index] ?? "unknown";
		return {
			filename,
			filePath: join(memoryDir, filename),
			mtimeMs: 0,
			sizeBytes: 0,
			readFailure: formatCaught(result.reason),
			metadata: {},
			validationIssues: [
				{
					path: filename,
					message: `failed to read memory file: ${formatCaught(result.reason)}`,
				},
			],
		};
	});
}

function parseFrontmatter(
	path: string,
	content: string,
): ParsedMemoryFrontmatter {
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") {
		return {
			metadata: {},
			issues: [{ path, message: "missing opening frontmatter delimiter" }],
		};
	}

	const frontmatter: Record<string, string> = {};
	const issues: MemoryValidationIssue[] = [];
	let closed = false;
	for (const [index, line] of lines.slice(1).entries()) {
		if (line.trim() === "---") {
			closed = true;
			break;
		}
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!match) {
			if (line.trim() && !line.trim().startsWith("#")) {
				issues.push({
					path,
					message: `invalid frontmatter syntax on line ${index + 2}`,
				});
			}
			continue;
		}
		const [, key, rawValue] = match;
		if (!key || rawValue === undefined) {
			continue;
		}
		if (!MEMORY_FRONTMATTER_KEYS.has(key)) {
			issues.push({ path, message: `unknown frontmatter key: ${key}` });
			continue;
		}
		if (Object.hasOwn(frontmatter, key)) {
			issues.push({ path, message: `duplicate frontmatter key: ${key}` });
			continue;
		}
		frontmatter[key] = rawValue.trim().replace(/^["']|["']$/g, "");
	}
	if (!closed) {
		issues.push({ path, message: "missing closing frontmatter delimiter" });
	}

	const metadata: MemoryMetadata = {};
	const type = parseMemoryType(frontmatter.type);
	const confidence = parseMemoryConfidence(frontmatter.confidence);
	const stability = parseMemoryStability(frontmatter.stability);
	const source = parseMemorySource(frontmatter.source);
	if (frontmatter.type && !type) {
		issues.push({
			path,
			message: `type must be one of: ${MEMORY_TYPES.join(", ")}`,
		});
	}
	if (frontmatter.confidence && !confidence) {
		issues.push({
			path,
			message: `confidence must be one of: ${MEMORY_CONFIDENCES.join(", ")}`,
		});
	}
	if (frontmatter.stability && !stability) {
		issues.push({
			path,
			message: `stability must be one of: ${MEMORY_STABILITIES.join(", ")}`,
		});
	}
	if (frontmatter.source && !source) {
		issues.push({
			path,
			message: `source must be one of: ${MEMORY_SOURCES.join(", ")}`,
		});
	}
	if (type) {
		metadata.type = type;
	}
	if (frontmatter.description) {
		metadata.description = frontmatter.description;
	}
	if (frontmatter.created_at) {
		metadata.createdAt = frontmatter.created_at;
	}
	if (frontmatter.updated_at) {
		metadata.updatedAt = frontmatter.updated_at;
	}
	if (source) {
		metadata.source = source;
	}
	if (confidence) {
		metadata.confidence = confidence;
	}
	if (stability) {
		metadata.stability = stability;
	}
	if (frontmatter.ttl) {
		metadata.ttl = frontmatter.ttl;
	}
	return { metadata, issues };
}

function formatMemoryFileSummary(memory: MemoryHeader): string {
	if (isMemoryIndexPath(memory.filename)) {
		return `${memory.filename} (index)`;
	}

	const details = [
		memory.metadata.type,
		memory.metadata.stability,
		memory.metadata.ttl ? `ttl=${memory.metadata.ttl}` : undefined,
		isMemoryExpired(memory.metadata) ? "expired" : undefined,
		memory.validationIssues.length > 0
			? `${memory.validationIssues.length} metadata issue(s)`
			: undefined,
	].filter(Boolean);
	const suffix = details.length ? ` (${details.join(", ")})` : "";
	return `${memory.filename}${suffix}`;
}

function formatMemoryIndex(memories: MemoryHeader[]): string {
	const visibleMemories = memories
		.filter((memory) => !isMemoryExpired(memory.metadata))
		.sort((a, b) => a.filename.localeCompare(b.filename));
	if (visibleMemories.length === 0) {
		return DEFAULT_MEMORY_INDEX_CONTENT;
	}

	const lines = visibleMemories.map((memory) => {
		const description =
			memory.metadata.description ?? "Missing memory description";
		const details = [
			memory.metadata.type,
			memory.metadata.stability,
			memory.validationIssues.length > 0
				? `${memory.validationIssues.length} metadata issue(s)`
				: undefined,
		].filter(Boolean);
		const suffix = details.length ? ` (${details.join(", ")})` : "";
		return `- [${escapeMarkdownLabel(description)}](${encodeMemoryLinkPath(memory.filename)})${suffix}`;
	});
	return `# Memory\n\n${lines.join("\n")}\n`;
}

async function writeMemoryIndexAtomically(
	cwd: string,
	indexPath: string,
	content: string,
): Promise<void> {
	await replaceMemoryFileAtomically(cwd, indexPath, content);
}

async function replaceMemoryFileAtomically(
	cwd: string,
	targetPath: string,
	content: string,
): Promise<void> {
	const [realCwd, memoryDir, resolvedTarget] = await Promise.all([
		resolveRealPathForWrite(cwd),
		resolveRealPathForWrite(getMemoryDir(cwd)),
		resolveRealPathForWrite(targetPath),
	]);
	const parentDir = dirname(resolvedTarget);
	const tempPath = join(
		parentDir,
		`.${basename(resolvedTarget)}.${randomUUID()}.tmp`,
	);
	await resolveContainedWritePath({
		targetPath: resolvedTarget,
		directoryPath: memoryDir,
		boundaryPath: realCwd,
	});
	await mkdir(parentDir, { recursive: true });
	await resolveContainedWritePath({
		targetPath: tempPath,
		directoryPath: memoryDir,
		boundaryPath: realCwd,
	});

	let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		tempHandle = await open(tempPath, "wx");
		await assertOpenedMemoryTempFile(tempHandle, tempPath, memoryDir, realCwd);
		await tempHandle.writeFile(content, "utf8");
		await tempHandle.sync();
		await assertOpenedMemoryTempFile(tempHandle, tempPath, memoryDir, realCwd);
		await resolveContainedWritePath({
			targetPath: resolvedTarget,
			directoryPath: memoryDir,
			boundaryPath: realCwd,
		});
		await resolveContainedWritePath({
			targetPath: tempPath,
			directoryPath: memoryDir,
			boundaryPath: realCwd,
		});
		await tempHandle.close();
		tempHandle = undefined;
		await rename(tempPath, resolvedTarget);
	} finally {
		await tempHandle?.close().catch(() => undefined);
		await rm(tempPath, { force: true }).catch(() => undefined);
	}
}

async function assertOpenedMemoryTempFile(
	handle: Awaited<ReturnType<typeof open>>,
	tempPath: string,
	memoryDir: string,
	realCwd: string,
): Promise<void> {
	await resolveContainedWritePath({
		targetPath: tempPath,
		directoryPath: memoryDir,
		boundaryPath: realCwd,
	});
	const [handleStat, pathStat] = await Promise.all([
		handle.stat({ bigint: true }),
		stat(tempPath, { bigint: true }),
	]);
	if (
		handleStat.ino === 0n ||
		handleStat.nlink !== 1n ||
		handleStat.dev !== pathStat.dev ||
		handleStat.ino !== pathStat.ino
	) {
		throw new Error(`Memory temporary file identity changed: ${tempPath}`);
	}
}

async function findDuplicateMemoryIssues(
	memories: MemoryHeader[],
): Promise<MemoryValidationIssue[]> {
	const issues: MemoryValidationIssue[] = [];
	const descriptions = new Map<string, string>();
	const bodies = new Map<string, string>();

	for (const memory of memories) {
		const description = normalizeDuplicateKey(
			memory.metadata.description ?? "",
		);
		if (description) {
			const existing = descriptions.get(description);
			if (existing) {
				issues.push({
					path: memory.filename,
					message: `duplicates existing memory description in ${existing}`,
				});
			} else {
				descriptions.set(description, memory.filename);
			}
		}

		if (memory.readFailure || memory.sizeBytes > MAX_MEMORY_TOPIC_BYTES) {
			continue;
		}
		const raw = await readMemoryBody(memory);
		const body = normalizeMemoryBody(raw);
		if (body) {
			const existing = bodies.get(body);
			if (existing) {
				issues.push({
					path: memory.filename,
					message: `duplicates existing memory content in ${existing}`,
				});
			} else {
				bodies.set(body, memory.filename);
			}
		}
	}

	return issues;
}

function normalizeDuplicateKey(value: string): string {
	return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

async function readMemoryBody(memory: MemoryHeader): Promise<string> {
	const result = await readTextPrefix(memory.filePath, MAX_MEMORY_TOPIC_BYTES);
	if (result.truncated) {
		throw new Error(
			`Memory file grew beyond ${MAX_MEMORY_TOPIC_BYTES} bytes while reading: ${memory.filename}`,
		);
	}
	return result.content;
}

async function readTextPrefix(
	path: string,
	maxBytes: number,
): Promise<{ content: string; truncated: boolean }> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const truncated = bytesRead > maxBytes;
		const bytes = buffer.subarray(0, Math.min(bytesRead, maxBytes));
		const content = new TextDecoder().decode(bytes, { stream: truncated });
		return { content, truncated };
	} finally {
		await handle.close();
	}
}

function truncateUtf8String(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf-8") <= maxBytes) {
		return value;
	}
	let bytes = 0;
	let truncated = "";
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf-8");
		if (bytes + characterBytes > maxBytes) {
			break;
		}
		truncated += character;
		bytes += characterBytes;
	}
	return truncated;
}

function normalizeMemoryBody(content: string): string {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	let body = content;
	if (lines[0]?.trim() === "---") {
		const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
		if (closing >= 0) {
			body = lines.slice(closing + 2).join("\n");
		}
	}
	return normalizeDuplicateKey(body);
}

function sameCanonicalPath(left: string, right: string): boolean {
	const normalize = (path: string) =>
		process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
	return normalize(left) === normalize(right);
}

async function withMemoryMutationLock<T>(
	cwd: string,
	operation: () => Promise<T>,
): Promise<T> {
	const canonicalCwd = await resolveRealPathForWrite(cwd);
	const key =
		process.platform === "win32" ? canonicalCwd.toLowerCase() : canonicalCwd;
	const previous = memoryMutationTails.get(key) ?? Promise.resolve();
	let release: () => void = () => undefined;
	const current = new Promise<void>((resolveCurrent) => {
		release = resolveCurrent;
	});
	const tail = previous.catch(() => undefined).then(() => current);
	memoryMutationTails.set(key, tail);

	await previous.catch(() => undefined);
	let releaseFileLock: (() => Promise<void>) | undefined;
	try {
		releaseFileLock = await acquireMemoryMutationFileLock(cwd);
		return await operation();
	} finally {
		try {
			await releaseFileLock?.();
		} finally {
			release();
			if (memoryMutationTails.get(key) === tail) {
				memoryMutationTails.delete(key);
			}
		}
	}
}

async function acquireMemoryMutationFileLock(
	cwd: string,
): Promise<() => Promise<void>> {
	const memoryDir = getMemoryDir(cwd);
	const lockPath = join(memoryDir, MEMORY_MUTATION_LOCK_NAME);
	await resolveContainedWritePath({
		targetPath: memoryDir,
		directoryPath: memoryDir,
		boundaryPath: cwd,
	});
	await mkdir(memoryDir, { recursive: true });
	await resolveContainedWritePath({
		targetPath: lockPath,
		directoryPath: memoryDir,
		boundaryPath: cwd,
	});
	const database = new Database(lockPath, { create: true, strict: true });
	const startedAt = Date.now();
	let transactionStarted = false;

	try {
		database.exec("PRAGMA busy_timeout = 0");
		const lockStat = await stat(lockPath, { bigint: true });
		if (!lockStat.isFile() || lockStat.nlink !== 1n || lockStat.ino === 0n) {
			throw new Error(
				`Memory mutation database has an unsafe file identity: ${lockPath}`,
			);
		}

		for (;;) {
			try {
				database.exec("BEGIN IMMEDIATE");
				transactionStarted = true;
				break;
			} catch (caught) {
				if (!isSqliteBusy(caught)) {
					throw caught;
				}
				if (Date.now() - startedAt >= MEMORY_MUTATION_LOCK_TIMEOUT_MS) {
					throw new Error(
						`Timed out waiting for memory mutation lock: ${lockPath}`,
					);
				}
				await delay(25 + Math.floor(Math.random() * 25));
			}
		}
		assertMemoryMutationDatabaseIntegrity(database, lockPath);

		return async () => {
			try {
				database.exec("COMMIT");
			} catch (caught) {
				try {
					database.exec("ROLLBACK");
				} catch {
					// Preserve the original commit error.
				}
				throw caught;
			} finally {
				database.close();
			}
		};
	} catch (caught) {
		if (transactionStarted) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Preserve the original acquisition or integrity error.
			}
		}
		database.close();
		throw caught;
	}
}

function assertMemoryMutationDatabaseIntegrity(
	database: Database,
	lockPath: string,
): void {
	let rows: { quick_check: string }[];
	try {
		rows = database
			.query<{ quick_check: string }, []>("PRAGMA quick_check")
			.all();
	} catch (caught) {
		throw new Error(
			`Memory mutation database failed integrity check: ${lockPath}: ${formatCaught(caught)}`,
			{ cause: caught },
		);
	}
	if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
		const details =
			rows.map((row) => row.quick_check).join("; ") || "no result";
		throw new Error(
			`Memory mutation database failed integrity check: ${lockPath}: ${details}`,
		);
	}
}

function isSqliteBusy(caught: unknown): boolean {
	return (
		caught instanceof Error &&
		"code" in caught &&
		(caught as { code?: unknown }).code === "SQLITE_BUSY"
	);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export function isMemoryIndexPath(path: string): boolean {
	return basename(path).toLowerCase() === MEMORY_ENTRYPOINT_NAME.toLowerCase();
}

function parseMemoryType(value: string | undefined): MemoryType | undefined {
	return MEMORY_TYPES.find((candidate) => candidate === value);
}

function parseMemoryConfidence(
	value: string | undefined,
): MemoryConfidence | undefined {
	return MEMORY_CONFIDENCES.find((candidate) => candidate === value);
}

function parseMemoryStability(
	value: string | undefined,
): MemoryStability | undefined {
	return MEMORY_STABILITIES.find((candidate) => candidate === value);
}

function parseMemorySource(
	value: string | undefined,
): MemorySource | undefined {
	return MEMORY_SOURCES.find((candidate) => candidate === value);
}

function isIsoDate(value: string): boolean {
	const timestamp = Date.parse(value);
	return (
		Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
	);
}

function parseSelectedMemoryJson(output: string): unknown[] | undefined {
	const trimmed = output.trim();
	const jsonText =
		trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() ?? trimmed;

	try {
		const parsed = JSON.parse(jsonText) as { selected_memories?: unknown };
		return Array.isArray(parsed.selected_memories)
			? parsed.selected_memories
			: undefined;
	} catch {
		return undefined;
	}
}

function truncateMemoryContent(raw: string): {
	content: string;
	truncated: boolean;
} {
	const lines = raw.trim().split("\n");
	let content = lines.slice(0, MAX_RELEVANT_MEMORY_LINES).join("\n");
	let truncated = lines.length > MAX_RELEVANT_MEMORY_LINES;

	if (Buffer.byteLength(content, "utf-8") > MAX_RELEVANT_MEMORY_BYTES) {
		truncated = true;
		let bytes = 0;
		const kept: string[] = [];
		for (const line of content.split("\n")) {
			const lineBytes = Buffer.byteLength(`${line}\n`, "utf-8");
			if (bytes + lineBytes > MAX_RELEVANT_MEMORY_BYTES) {
				break;
			}
			kept.push(line);
			bytes += lineBytes;
		}
		content = kept.join("\n");
	}

	return { content, truncated };
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeMarkdownLabel(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replaceAll("[", "\\[")
		.replaceAll("]", "\\]");
}

function encodeMemoryLinkPath(filename: string): string {
	return filename
		.split("/")
		.map((segment) =>
			encodeURIComponent(segment).replace(
				/[!'()*]/g,
				(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
			),
		)
		.join("/");
}

function formatMemoryIndexForPrompt(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed || trimmed === DEFAULT_MEMORY_INDEX_CONTENT.trim()) {
		return "Memory index is currently empty.";
	}

	const lines = trimmed.split("\n");
	let truncated = lines.slice(0, MAX_MEMORY_INDEX_LINES).join("\n");
	let wasTruncated = lines.length > MAX_MEMORY_INDEX_LINES;

	if (Buffer.byteLength(truncated, "utf-8") > MAX_MEMORY_INDEX_BYTES) {
		wasTruncated = true;
		let bytes = 0;
		const kept: string[] = [];
		for (const line of truncated.split("\n")) {
			const lineBytes = Buffer.byteLength(`${line}\n`, "utf-8");
			if (bytes + lineBytes > MAX_MEMORY_INDEX_BYTES) {
				break;
			}
			kept.push(line);
			bytes += lineBytes;
		}
		truncated = kept.join("\n");
	}

	if (!wasTruncated) {
		return truncated;
	}

	return `${truncated}\n\n> MEMORY.md was truncated for prompt size. Read the file directly if more detail is needed.`;
}

function hasErrnoCode(error: unknown, code: string): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}

function formatCaught(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}
