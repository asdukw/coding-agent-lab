import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "./types";

const inputSchema = z.object({
	file_path: z
		.string()
		.describe("Absolute or relative path to the file to read"),
	offset: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("1-based line number to start reading from"),
	limit: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Maximum number of lines to read"),
});

type Input = z.infer<typeof inputSchema>;
type Output = { content: string; totalLines: number };

export const readTool: Tool<Input, Output> = {
	name: "Read",
	description:
		"Read a text file from the local filesystem, optionally a line range",
	inputSchema,
	async call({ file_path, offset, limit }) {
		const text = await readFile(file_path, "utf-8");
		const lines = text.split("\n");
		const start = offset ? offset - 1 : 0;
		const end = limit ? start + limit : lines.length;
		const content = lines.slice(start, end).join("\n");
		return { content, totalLines: lines.length };
	},
};
