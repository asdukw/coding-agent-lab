import type { ModelClient } from "./model/client";
import { getPlanModeReminder } from "./plan";
import {
	type AgentState,
	ensureToolPermissionContext,
	type Message,
} from "./state";
import { authorizeToolCall, getToolsForMode } from "./tools/permissions";
import { EXIT_PLAN_MODE_TOOL_NAME } from "./tools/planToolNames";
import { type Tools, toToolSpecs } from "./tools/types";

export type QueryParams = {
	initialState: AgentState;
	model: ModelClient;
	tools?: Tools;
};

export type Terminal = {
	reason: "complete" | "max_turns" | "model_error" | "plan_approval";
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
			type: "plan_approval_request";
			plan: string;
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
		...ensureToolPermissionContext(initialState),
		toolSpecs: toToolSpecs(
			getToolsForMode(ensureToolPermissionContext(initialState), runtimeTools),
		),
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
		const activeTools = getToolsForMode(state, runtimeTools);
		state = {
			...state,
			toolSpecs: toToolSpecs(activeTools),
		};

		yield {
			type: "request_start",
			model: model.name,
		};

		let roundText = "";
		const toolCalls: { id: string; name: string; arguments: string }[] = [];

		for await (const event of model.stream({
			messages: buildModelMessages(state),
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
		yield {
			type: "message",
			message: assistantMessage,
		};

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
				authorizeToolCall(state, tool, args);
				const output = await tool.call(args, {
					getState: () => state,
					setState(next) {
						state = typeof next === "function" ? next(state) : next;
					},
				});
				resultContent = JSON.stringify(output);
			} catch (caught) {
				ok = false;
				resultContent = `error: ${caught instanceof Error ? caught.message : String(caught)}`;
			}

			const toolMessage: Message = {
				role: "tool",
				content: resultContent,
				toolCallId: call.id,
			};
			state = {
				...state,
				lastToolCall: { name: call.name, args },
				observations: [
					...state.observations,
					{ tool: call.name, args, ok, output: resultContent },
				],
				messages: [...state.messages, toolMessage],
			};
			yield {
				type: "message",
				message: toolMessage,
			};

			const pendingPlanApproval =
				state.toolPermissionContext.pendingPlanApproval;
			if (ok && call.name === EXIT_PLAN_MODE_TOOL_NAME && pendingPlanApproval) {
				yield {
					type: "plan_approval_request",
					plan: pendingPlanApproval.plan,
					state,
				};
				yield { type: "state", state };

				const terminal: Terminal = {
					reason: "plan_approval",
					state,
				};
				yield {
					type: "terminal",
					terminal,
				};
				return terminal;
			}
		}
	}
}

function buildModelMessages(state: AgentState): Message[] {
	if (state.toolPermissionContext.mode !== "plan") {
		return state.messages;
	}

	return [
		{ role: "system", content: getPlanModeReminder(state) },
		...state.messages,
	];
}
