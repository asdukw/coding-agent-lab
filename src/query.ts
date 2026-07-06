import type { ModelClient } from "./model/client";
import type { AgentState, Message } from "./state";
import { type Tools, toToolSpecs } from "./tools/types";

export type QueryParams = {
	initialState: AgentState;
	model: ModelClient;
	tools?: Tools;
};

export type Terminal = {
	reason: "complete" | "max_turns" | "model_error";
	state: AgentState;
};

export type QueryEvent =
	| {
			type: "request_start";
			model: string;
	  }
	| {
			type: "stream_delta";
			content: string;
	  }
	| {
			type: "message";
			message: Message;
	  }
	| {
			type: "state";
			state: AgentState;
	  }
	| {
			type: "terminal";
			terminal: Terminal;
	  };

export async function* query({
	initialState,
	model,
	tools,
}: QueryParams): AsyncGenerator<QueryEvent, Terminal> {
	const runtimeTools = tools ?? [];
	let state: AgentState = {
		...initialState,
		toolSpecs:
			initialState.toolSpecs.length > 0
				? initialState.toolSpecs
				: toToolSpecs(runtimeTools),
		todos: [
			{
				id: "1",
				content: "Initialize TypeScript agent loop",
				status: "done",
			},
		],
	};

	for (;;) {
		// budget.turnsUsed/budget.maxTurns is the source of truth for the turn
		// cap; AgentState.maxTurns is a separate, unreconciled duplicate field.
		if (state.budget.turnsUsed >= state.budget.maxTurns) {
			state = { ...state, transition: { reason: "max_turns" } };
			const terminal: Terminal = { reason: "max_turns", state };
			yield { type: "terminal", terminal };
			return terminal;
		}

		state = {
			...state,
			turn: state.turn + 1,
			budget: {
				...state.budget,
				turnsUsed: state.budget.turnsUsed + 1,
			},
			transition: { reason: "next_turn" },
		};

		yield {
			type: "request_start",
			model: model.name,
		};

		let roundText = "";
		const toolCalls: { id: string; name: string; arguments: string }[] = [];

		for await (const event of model.stream({
			messages: state.messages,
			toolSpecs: state.toolSpecs,
		})) {
			if (event.type === "text_delta") {
				roundText += event.content;
				yield {
					type: "stream_delta",
					content: event.content,
				};
			} else {
				toolCalls.push(event);
			}
		}

		if (toolCalls.length === 0) {
			const assistantMessage: Message = {
				role: "assistant",
				content: roundText,
			};

			state = {
				...state,
				finalAnswer: roundText,
				transition: { reason: "complete" },
				messages: [...state.messages, assistantMessage],
			};

			yield {
				type: "message",
				message: assistantMessage,
			};

			yield {
				type: "state",
				state,
			};

			const terminal: Terminal = {
				reason: "complete",
				state,
			};

			yield {
				type: "terminal",
				terminal,
			};

			return terminal;
		}

		const assistantMessage: Message = {
			role: "assistant",
			content: roundText,
			toolCalls,
		};
		state = { ...state, messages: [...state.messages, assistantMessage] };

		for (const call of toolCalls) {
			let ok = true;
			let resultContent: string;
			let args: Record<string, unknown> = {};

			try {
				const tool = runtimeTools.find((t) => t.name === call.name);
				if (!tool) {
					throw new Error(`unknown tool: ${call.name}`);
				}
				args = tool.inputSchema.parse(JSON.parse(call.arguments)) as Record<
					string,
					unknown
				>;
				const output = await tool.call(args);
				resultContent = JSON.stringify(output);
			} catch (caught) {
				ok = false;
				resultContent = `error: ${caught instanceof Error ? caught.message : String(caught)}`;
			}

			state = {
				...state,
				lastToolCall: { name: call.name, args },
				observations: [
					...state.observations,
					{ tool: call.name, args, ok, output: resultContent },
				],
				messages: [
					...state.messages,
					{ role: "tool", content: resultContent, toolCallId: call.id },
				],
			};
		}
	}
}
