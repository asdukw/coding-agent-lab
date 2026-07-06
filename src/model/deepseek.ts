import OpenAI from "openai";
import type {
	ChatCompletionMessageParam,
	ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { ToolSpec } from "../tools/types";
import type { ModelClient, ModelRequest, ModelStreamEvent } from "./client";

export type DeepSeekModelOptions = {
	apiKey: string;
	baseURL?: string;
	model?: string;
};

export class DeepSeekModelClient implements ModelClient {
	readonly name: string;
	private readonly client: OpenAI;
	private readonly model: string;

	constructor(options: DeepSeekModelOptions) {
		this.model = options.model ?? "deepseek-v4-flash";
		this.name = `deepseek:${this.model}`;
		this.client = new OpenAI({
			apiKey: options.apiKey,
			baseURL: options.baseURL ?? "https://api.deepseek.com",
		});
	}

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		const stream = await this.client.chat.completions.create({
			model: this.model,
			messages: toOpenAIMessages(request),
			tools: toOpenAITools(request.toolSpecs),
			stream: true,
		});

		const toolCalls = new Map<
			number,
			{ id?: string; name?: string; args: string }
		>();

		for await (const chunk of stream) {
			const delta = chunk.choices[0]?.delta;
			if (delta?.content) {
				yield { type: "text_delta", content: delta.content };
			}

			for (const toolCall of delta?.tool_calls ?? []) {
				const entry = toolCalls.get(toolCall.index) ?? { args: "" };
				entry.id ??= toolCall.id;
				entry.name ??= toolCall.function?.name;
				entry.args += toolCall.function?.arguments ?? "";
				toolCalls.set(toolCall.index, entry);
			}
		}

		for (const index of [...toolCalls.keys()].sort((a, b) => a - b)) {
			const entry = toolCalls.get(index);
			if (!entry?.id || !entry.name) {
				continue;
			}
			yield {
				type: "tool_call",
				id: entry.id,
				name: entry.name,
				arguments: entry.args,
			};
		}
	}
}

function toOpenAITools(
	tools: ToolSpec[] | undefined,
): ChatCompletionTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}

	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema as Record<string, unknown>,
		},
	}));
}

function toOpenAIMessages(request: ModelRequest): ChatCompletionMessageParam[] {
	const messages: ChatCompletionMessageParam[] = [];

	for (const message of request.messages) {
		switch (message.role) {
			case "system":
				messages.push({ role: "system", content: message.content });
				break;
			case "user":
				messages.push({ role: "user", content: message.content });
				break;
			case "assistant":
				messages.push({
					role: "assistant",
					content: message.content,
					tool_calls: message.toolCalls?.map((toolCall) => ({
						id: toolCall.id,
						type: "function",
						function: { name: toolCall.name, arguments: toolCall.arguments },
					})),
				});
				break;
			case "tool":
				if (!message.toolCallId) {
					throw new Error("tool message is missing toolCallId");
				}
				messages.push({
					role: "tool",
					tool_call_id: message.toolCallId,
					content: message.content,
				});
				break;
		}
	}

	return messages;
}
