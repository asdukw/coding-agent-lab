import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export const MEMORY_DIR_NAME = "memory";
export const MEMORY_ENTRYPOINT_NAME = "MEMORY.md";

const DEFAULT_MEMORY_INDEX_CONTENT = "# Memory\n\n";
const MAX_MEMORY_INDEX_LINES = 200;
const MAX_MEMORY_INDEX_BYTES = 25_000;

export type MemoryStoreInfo = {
	memoryDir: string;
	indexPath: string;
	files: string[];
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
