import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
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
	async call({ file_path, content }) {
		await mkdir(dirname(file_path), { recursive: true });
		await writeFile(file_path, content, "utf-8");
		return { bytesWritten: Buffer.byteLength(content, "utf-8") };
	},
};
