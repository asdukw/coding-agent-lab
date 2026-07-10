import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { resolveMemoryWriteTarget, writeValidatedMemoryFile } from "../memory";
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
	isReadOnly: false,
	isConcurrencySafe: false,
	inputSchema,
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
