import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Message } from "./state";

export const MEMORY_DIR_NAME = "memory";
export const MEMORY_ENTRYPOINT_NAME = "MEMORY.md";

const DEFAULT_MEMORY_INDEX_CONTENT = "# Memory\n\n";
const MAX_MEMORY_INDEX_LINES = 200;
const MAX_MEMORY_INDEX_BYTES = 25_000;
const MAX_MEMORY_FILES = 200;
const FRONTMATTER_MAX_LINES = 40;
const MAX_RELEVANT_MEMORY_FILES = 5;
const MAX_RELEVANT_MEMORY_LINES = 200;
const MAX_RELEVANT_MEMORY_BYTES = 20_000;

export type MemoryStoreInfo = {
	memoryDir: string;
	indexPath: string;
	files: string[];
};

export type MemoryHeader = {
	filename: string;
	filePath: string;
	mtimeMs: number;
	type?: string;
	description?: string;
};

export type RelevantMemory = {
	path: string;
	content: string;
	mtimeMs: number;
	truncated: boolean;
};

export function getMemoryDir(cwd: string): string {
	return join(cwd, ".cagent", MEMORY_DIR_NAME);
}

export function getMemoryIndexPath(cwd: string): string {
	return join(getMemoryDir(cwd), MEMORY_ENTRYPOINT_NAME);
}

export async function ensureMemoryStore(cwd: string): Promise<MemoryStoreInfo> {
	const memoryDir = getMemoryDir(cwd);
	const indexPath = getMemoryIndexPath(cwd);

	await mkdir(memoryDir, { recursive: true });
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
		files: await listMemoryFiles(memoryDir),
	};
}

export async function loadMemoryPrompt(cwd: string): Promise<string> {
	const info = await ensureMemoryStore(cwd);
	const rawIndex = await readFile(info.indexPath, "utf-8");
	const index = formatMemoryIndexForPrompt(rawIndex);

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
		"Write durable memories as focused markdown topic files under the memory directory. Keep MEMORY.md as a short one-line index of those files.",
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
		? info.files.map((file) => `- ${file}`).join("\n")
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
	const files = info.files.filter((file) => file !== MEMORY_ENTRYPOINT_NAME);

	const results = await Promise.allSettled(
		files
			.slice(0, MAX_MEMORY_FILES)
			.map(async (filename): Promise<MemoryHeader> => {
				const filePath = join(info.memoryDir, filename);
				const [headerText, fileStat] = await Promise.all([
					readFile(filePath, "utf-8").then((text) =>
						text.split("\n").slice(0, FRONTMATTER_MAX_LINES).join("\n"),
					),
					stat(filePath),
				]);
				const frontmatter = parseFrontmatter(headerText);
				return {
					filename,
					filePath,
					mtimeMs: fileStat.mtimeMs,
					type: frontmatter.type,
					description: frontmatter.description,
				};
			}),
	);

	return results
		.filter((result): result is PromiseFulfilledResult<MemoryHeader> => {
			return result.status === "fulfilled";
		})
		.map((result) => result.value)
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function formatMemoryManifest(memories: MemoryHeader[]): string {
	return memories
		.map((memory) => {
			const type = memory.type ? `[${memory.type}] ` : "";
			const modified = new Date(memory.mtimeMs).toISOString();
			return memory.description
				? `- ${type}${memory.filename} (${modified}): ${memory.description}`
				: `- ${type}${memory.filename} (${modified})`;
		})
		.join("\n");
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

			const raw = await readFile(memory.filePath, "utf-8");
			const formatted = truncateMemoryContent(raw);
			return {
				path: memory.filename,
				content: formatted.content,
				mtimeMs: memory.mtimeMs,
				truncated: formatted.truncated,
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
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) {
				continue;
			}

			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				files.push(relative(memoryDir, fullPath).replace(/\\/g, "/"));
			}
		}
	}

	await walk(memoryDir);
	return files.sort((a, b) => {
		if (a === MEMORY_ENTRYPOINT_NAME) {
			return -1;
		}
		if (b === MEMORY_ENTRYPOINT_NAME) {
			return 1;
		}
		return a.localeCompare(b);
	});
}

function parseFrontmatter(content: string): {
	type?: string;
	description?: string;
} {
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") {
		return {};
	}

	const frontmatter: Record<string, string> = {};
	for (const line of lines.slice(1)) {
		if (line.trim() === "---") {
			break;
		}
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!match) {
			continue;
		}
		const [, key, rawValue] = match;
		if (!key || rawValue === undefined) {
			continue;
		}
		frontmatter[key] = rawValue.trim().replace(/^["']|["']$/g, "");
	}

	return {
		type: frontmatter.type,
		description: frontmatter.description,
	};
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
