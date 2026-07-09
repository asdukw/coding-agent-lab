import { glob } from "glob";
import { z } from "zod";
import type { Tool } from "./types";

const inputSchema = z.object({
	pattern: z
		.string()
		.describe('Glob pattern to match files against, e.g. "src/**/*.ts"'),
	path: z
		.string()
		.optional()
		.describe(
			"Directory to search in; defaults to the current working directory",
		),
});

type Input = z.infer<typeof inputSchema>;
type Output = { filenames: string[] };

export const globTool: Tool<Input, Output> = {
	name: "Glob",
	description: "Find files matching a glob pattern",
	isReadOnly: true,
	isConcurrencySafe: true,
	inputSchema,
	async call({ pattern, path }) {
		const filenames = await glob(pattern, { cwd: path ?? process.cwd() });
		return { filenames };
	},
};
