import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "./types";

const inputSchema = z.object({
	file_path: z
		.string()
		.describe("Absolute or relative path to the file to edit"),
	old_string: z.string().describe("Exact text to find and replace"),
	new_string: z.string().describe("Text to replace it with"),
	replace_all: z
		.boolean()
		.optional()
		.describe("Replace every occurrence instead of requiring exactly one"),
});

type Input = z.infer<typeof inputSchema>;
type Output = { replacements: number };

export const editTool: Tool<Input, Output> = {
	name: "Edit",
	description: "Find and replace an exact string in a file",
	isReadOnly: false,
	isConcurrencySafe: false,
	inputSchema,
	async call({ file_path, old_string, new_string, replace_all }) {
		const text = await readFile(file_path, "utf-8");
		const occurrences = text.split(old_string).length - 1;

		if (occurrences === 0) {
			throw new Error(`old_string not found in ${file_path}`);
		}
		if (!replace_all && occurrences > 1) {
			throw new Error(
				`old_string matched ${occurrences} times in ${file_path}; pass replace_all or make old_string unique`,
			);
		}

		const replacements = replace_all ? occurrences : 1;
		const updated = replace_all
			? text.split(old_string).join(new_string)
			: text.replace(old_string, new_string);

		await writeFile(file_path, updated, "utf-8");
		return { replacements };
	},
};
