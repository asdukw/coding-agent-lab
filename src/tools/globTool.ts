import { resolve } from "node:path";
import { glob } from "glob";
import { z } from "zod";
import { isSafeWorkspaceReadPath } from "./permissions";
import { fileResourceAccesses, resolveToolPath } from "./resourceLock";
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
	inputSchema,
	async getResourceAccesses(input, context) {
		const cwd = context?.getState().cwd ?? process.cwd();
		input.path = resolveToolPath(cwd, input.path ?? ".");
		return fileResourceAccesses(input.path, "read", "subtree");
	},
	async call({ pattern, path }, context) {
		const cwd = path ?? process.cwd();
		const state = context?.getState();
		const workspaceRoot = state?.cwd ?? cwd;
		const discovered = await glob(pattern, { cwd });
		const safe = await Promise.all(
			discovered.map((filename) =>
				isSafeWorkspaceReadPath(
					workspaceRoot,
					resolve(cwd, filename),
					state?.toolPermissionContext.agentType,
				),
			),
		);
		const filenames = discovered.filter((_filename, index) => safe[index]);
		return { filenames };
	},
};
