import type { z } from "zod";

export type Tool<Input = unknown, Output = unknown> = {
	name: string;
	description: string;
	inputSchema: z.ZodType<Input>;
	call(input: Input): Promise<Output>;
};

export type Tools = readonly Tool[];
