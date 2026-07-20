import type { Message } from "../state";
import type { ToolSpec } from "../tools/types";

export type ModelRequest = {
	messages: Message[];
	toolSpecs?: ToolSpec[];
	signal?: AbortSignal;
};

export type ModelStreamEvent =
	| { type: "text_delta"; content: string }
	| { type: "tool_call"; id: string; name: string; arguments: string };

export type ModelClient = {
	name: string;
	supportsMemoryExtraction?: boolean;
	stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent>;
};
