import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { resolveMemoryWriteTarget, writeValidatedMemoryFile } from "../memory";
import {
	fileResourceAccesses,
	memoryResourceAccess,
	resolveToolPath,
} from "./resourceLock";
import type { Tool } from "./types";

const inputSchema = z.object({
	file_path: z.string().describe("Absolute or relative path to write"),
	content: z
		.string()
		.describe("Full file content to write (overwrites any existing file)"),
});

type Input = z.infer<typeof inputSchema>;
type Output = { bytesWritten: number };

export const writeTool: Tool<Input, Output> = {
	name: "Write",
	description:
		"Write content to a file, creating parent directories and overwriting any existing content",
	inputSchema,
	async getResourceAccesses(input, context) {
		const state = context?.getState();
		input.file_path = resolveToolPath(
			state?.cwd ?? process.cwd(),
			input.file_path,
		);
		const accesses = await fileResourceAccesses(input.file_path, "write");
		if (state && (await resolveMemoryWriteTarget(state.cwd, input.file_path))) {
			accesses.push(await memoryResourceAccess(state.cwd, "write"));
		}
		return accesses;
	},
	async call({ file_path, content }, context) {
		const state = context?.getState();
		const memoryTarget = state
			? await resolveMemoryWriteTarget(state.cwd, file_path)
			: undefined;
		if (state && memoryTarget) {
			return {
				bytesWritten: await writeValidatedMemoryFile(
					state.cwd,
					memoryTarget,
					content,
				),
			};
		}
		await mkdir(dirname(file_path), { recursive: true });
		await writeFile(file_path, content, "utf-8");
		return { bytesWritten: Buffer.byteLength(content, "utf-8") };
	},
};
