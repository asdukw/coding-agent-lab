import type { z } from "zod";
import { toJSONSchema } from "zod";
import type { AgentState } from "../state";

export type ToolContext = {
	getState(): AgentState;
	setState(next: AgentState | ((state: AgentState) => AgentState)): void;
};

export type Tool<Input = unknown, Output = unknown> = {
	name: string;
	description: string;
	inputSchema: z.ZodType<Input>;
	call(input: Input, context?: ToolContext): Promise<Output>;
};

export type Tools = readonly Tool[];

export type ToolSpec = {
	name: string;
	description: string;
	inputSchema: unknown;
};

export function toToolSpec(tool: Tool): ToolSpec {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: toJSONSchema(tool.inputSchema),
	};
}

export function toToolSpecs(tools: Tools = []): ToolSpec[] {
	return tools.map(toToolSpec);
}
