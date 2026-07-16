import { readFile } from "node:fs/promises";
import { glob } from "glob";
import { z } from "zod";
import { fileResourceAccesses, resolveToolPath } from "./resourceLock";
import type { Tool } from "./types";

const inputSchema = z.object({
	pattern: z.string().describe("Regular expression to search for"),
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

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];

export const grepTool: Tool<Input, Output> = {
	name: "Grep",
	description: "Search file contents for a regular expression",
	inputSchema,
	async getResourceAccesses(input, context) {
		const cwd = context?.getState().cwd ?? process.cwd();
		input.path = resolveToolPath(cwd, input.path ?? ".");
		return fileResourceAccesses(input.path, "read", "subtree");
	},
	async call({
		pattern,
		path,
		glob: globFilter,
		ignore_case,
		output_mode = "files_with_matches",
	}) {
		const cwd = path ?? process.cwd();
		const regex = new RegExp(pattern, ignore_case ? "i" : "");
		const files = await glob(globFilter ?? "**/*", {
			cwd,
			nodir: true,
			ignore: DEFAULT_IGNORE,
		});

		const filesWithMatches: string[] = [];
		const matchingLines: string[] = [];
		let matchCount = 0;

		for (const file of files) {
			let text: string;
			try {
				text = await readFile(`${cwd}/${file}`, "utf-8");
			} catch {
				continue;
			}
			if (text.includes("\0")) {
				continue; // skip binary files
			}

			const lines = text.split("\n");
			let fileMatched = false;
			lines.forEach((line, index) => {
				if (regex.test(line)) {
					fileMatched = true;
					matchCount++;
					matchingLines.push(`${file}:${index + 1}:${line}`);
				}
			});
			if (fileMatched) {
				filesWithMatches.push(file);
			}
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
