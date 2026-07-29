import { resolve } from "node:path";
import { z } from "zod";
import { hasDangerFullAccess } from "../state";
import { isSafeWorkspaceReadPath } from "./permissions";
import { fileResourceAccesses, resolveToolPath } from "./resourceLock";
import { runRipgrep } from "./ripgrep";
import type { Tool } from "./types";

const inputSchema = z.object({
	pattern: z.string().describe("ripgrep regular expression to search for"),
	path: z
		.string()
		.optional()
		.describe(
			"Directory to search in; defaults to the current working directory",
		),
	glob: z
		.string()
		.optional()
		.describe('Glob filter for which files to search, e.g. "*.ts"'),
	ignore_case: z.boolean().optional().describe("Case-insensitive match"),
	output_mode: z
		.enum(["content", "files_with_matches", "count"])
		.optional()
		.describe(
			"What to return: matching lines, matching file paths, or a match count",
		),
});

type Input = z.infer<typeof inputSchema>;
type Output = { output: string };

type RipgrepMatch = {
	type: "match";
	data: {
		path: { text?: string };
		lines: { text?: string };
		line_number: number;
	};
};

export const grepTool: Tool<Input, Output> = {
	name: "Grep",
	description: "Search file contents for a regular expression",
	inputSchema,
	async getResourceAccesses(input, context) {
		const cwd = context?.getState().cwd ?? process.cwd();
		input.path = resolveToolPath(cwd, input.path ?? ".");
		return fileResourceAccesses(input.path, "read", "subtree");
	},
	async call(
		{
			pattern,
			path,
			glob: globFilter,
			ignore_case,
			output_mode = "files_with_matches",
		},
		context,
	) {
		const cwd = path ?? process.cwd();
		const state = context?.getState();
		const workspaceRoot = state?.cwd ?? cwd;
		const dangerFullAccess = state ? hasDangerFullAccess(state) : false;
		const discoveryArgs = [
			"--files",
			"--null",
			"--path-separator",
			"/",
			"--glob",
			"!node_modules/**",
			"--glob",
			"!.git/**",
		];
		if (globFilter) {
			discoveryArgs.push("--glob", globFilter);
		}
		const { stdout: discoveredOutput } = await runRipgrep(discoveryArgs, {
			cwd,
			signal: context?.signal,
		});
		const discovered = discoveredOutput.split("\0").filter(Boolean);
		const safe = await Promise.all(
			discovered.map((file) =>
				isSafeWorkspaceReadPath(
					workspaceRoot,
					resolve(cwd, file),
					state?.toolPermissionContext.agentType,
					dangerFullAccess,
				),
			),
		);
		const files = discovered.filter((_file, index) => safe[index]);
		const matches = await searchFilesWithRipgrep(
			files,
			{ pattern, ignoreCase: ignore_case === true },
			{ cwd, signal: context?.signal },
		);
		const filesWithMatches: string[] = [];
		const matchingLines: string[] = [];
		let matchCount = 0;
		const seenFiles = new Set<string>();
		for (const match of matches) {
			const file = match.data.path.text;
			const line = match.data.lines.text;
			if (!file || line === undefined) {
				continue;
			}
			if (!seenFiles.has(file)) {
				seenFiles.add(file);
				filesWithMatches.push(file);
			}
			matchCount++;
			matchingLines.push(
				`${file}:${match.data.line_number}:${line.replace(/\r?\n$/u, "")}`,
			);
		}

		if (output_mode === "files_with_matches") {
			return { output: filesWithMatches.join("\n") };
		}
		if (output_mode === "count") {
			return { output: String(matchCount) };
		}
		return { output: matchingLines.join("\n") };
	},
};

async function searchFilesWithRipgrep(
	files: string[],
	search: { pattern: string; ignoreCase: boolean },
	options: { cwd: string; signal?: AbortSignal },
): Promise<RipgrepMatch[]> {
	if (files.length === 0) {
		return [];
	}

	const matches: RipgrepMatch[] = [];
	const batches = batchFileArguments(files);
	for (const batch of batches) {
		const args = [
			"--json",
			"--line-number",
			"--no-messages",
			"--path-separator",
			"/",
		];
		if (search.ignoreCase) {
			args.push("--ignore-case");
		}
		args.push("--", search.pattern, ...batch);
		const { stdout } = await runRipgrep(args, options);
		matches.push(...parseRipgrepMatches(stdout));
	}
	return matches;
}

function batchFileArguments(files: string[]): string[][] {
	const batches: string[][] = [];
	let batch: string[] = [];
	let commandLength = 0;
	for (const file of files) {
		if (
			batch.length > 0 &&
			(batch.length >= 256 || commandLength + file.length > 24_000)
		) {
			batches.push(batch);
			batch = [];
			commandLength = 0;
		}
		batch.push(file);
		commandLength += file.length + 3;
	}
	if (batch.length > 0) {
		batches.push(batch);
	}
	return batches;
}

function parseRipgrepMatches(stdout: string): RipgrepMatch[] {
	const matches: RipgrepMatch[] = [];
	for (const line of stdout.split(/\r?\n/u)) {
		if (!line) {
			continue;
		}
		const event = JSON.parse(line) as { type?: string };
		if (event.type === "match") {
			matches.push(event as RipgrepMatch);
		}
	}
	return matches;
}
