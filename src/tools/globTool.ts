import { resolve } from "node:path";
import { z } from "zod";
import { hasDangerFullAccess } from "../state";
import { isSafeWorkspaceReadPath } from "./permissions";
import { fileResourceAccesses, resolveToolPath } from "./resourceLock";
import { runRipgrep } from "./ripgrep";
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
		const dangerFullAccess = state ? hasDangerFullAccess(state) : false;
		const { stdout } = await runRipgrep(
			["--files", "--null", "--path-separator", "/", "--glob", pattern],
			{ cwd, signal: context?.signal },
		);
		const discovered = stdout
			.split("\0")
			.filter(Boolean)
			.sort((left, right) => left.localeCompare(right));
		const safe = await Promise.all(
			discovered.map((filename) =>
				isSafeWorkspaceReadPath(
					workspaceRoot,
					resolve(cwd, filename),
					state?.toolPermissionContext.agentType,
					dangerFullAccess,
				),
			),
		);
		const filenames = discovered.filter((_filename, index) => safe[index]);
		return { filenames };
	},
};
