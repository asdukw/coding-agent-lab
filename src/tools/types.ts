import type { z } from "zod";
import { toJSONSchema } from "zod";
import type { AgentState } from "../state";
import type { ResourceAccess } from "./resourceLock";

export type ToolContext = {
	getState(): AgentState;
	setState(next: AgentState | ((state: AgentState) => AgentState)): void;
};

export type Tool<Input = unknown, Output = unknown> = {
	name: string;
	description: string;
	inputSchema: z.ZodType<Input>;
	getResourceAccesses?(
		input: Input,
		context?: ToolContext,
	): ResourceAccess[] | Promise<ResourceAccess[]>;
	/**
	 * An externally supplied JSON Schema. MCP tools use this instead of a
	 * generated Zod schema so the model receives the server's exact contract.
	 */
	inputJSONSchema?: unknown;
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
		inputSchema: tool.inputJSONSchema ?? toJSONSchema(tool.inputSchema),
	};
}

export function toToolSpecs(tools: Tools = []): ToolSpec[] {
	return tools.map(toToolSpec);
}
