import { type AutoCompactOptions, autoCompactIfNeeded } from "./compact";
import {
	buildMemorySelectionMessages,
	formatMemoryManifest,
	formatRelevantMemoriesPrompt,
	loadMemoryPrompt,
	parseSelectedMemoryFilenames,
	readRelevantMemories,
	scanMemoryFiles,
} from "./memory";
import type { ModelClient } from "./model/client";
import { getPlanModeReminder } from "./plan";
import {
	type AgentState,
	ensureToolPermissionContext,
	type Message,
} from "./state";
import { getToolsForMode } from "./tools/permissions";
import { EXIT_PLAN_MODE_TOOL_NAME } from "./tools/planToolNames";
import { runToolCall } from "./tools/runner";
import { type Tools, toToolSpecs } from "./tools/types";

export type QueryParams = {
	initialState: AgentState;
	model: ModelClient;
	tools?: Tools;
	enableMemoryExtraction?: boolean;
	autoCompactOptions?: AutoCompactOptions;
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
			type: "compaction";
			state: AgentState;
	  }
	| {
			type: "plan_approval_request";
			plan: string;
			state: AgentState;
	  }
	| {
			type: "memory_extraction_request";
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
	enableMemoryExtraction = true,
	autoCompactOptions,
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
	let queryHadToolCalls = false;

	for (;;) {
		// budget.turnsUsed/budget.maxTurns is the source of truth for the turn
		// cap; AgentState.maxTurns is a separate, unreconciled duplicate field.
		if (state.budget.turnsUsed >= state.budget.maxTurns) {
			state = { ...state, transition: { reason: "max_turns" } };
			const terminal: Terminal = { reason: "max_turns", state };
			yield { type: "terminal", terminal };
			return terminal;
		}

		const compaction = await autoCompactIfNeeded(
			state,
			model,
			autoCompactOptions,
		);
		state = compaction.state;
		if (compaction.didCompact) {
			yield { type: "compaction", state };
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
			messages: await buildModelMessages(state, model),
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

			if (
				enableMemoryExtraction &&
				!queryHadToolCalls &&
				shouldRequestMemoryExtraction(state)
			) {
				yield {
					type: "memory_extraction_request",
					state,
				};
			}

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

		queryHadToolCalls = true;
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
			const result = await runToolCall({
				call,
				tools: runtimeTools,
				context: {
					getState: () => state,
					setState(next) {
						state = typeof next === "function" ? next(state) : next;
					},
				},
			});
			state = {
				...state,
				lastToolCall: { name: call.name, args: result.args },
				observations: [...state.observations, result.observation],
				messages: [...state.messages, result.message],
			};
			yield {
				type: "message",
				message: result.message,
			};

			const pendingPlanApproval =
				state.toolPermissionContext.pendingPlanApproval;
			if (
				result.ok &&
				call.name === EXIT_PLAN_MODE_TOOL_NAME &&
				pendingPlanApproval
			) {
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

async function buildModelMessages(
	state: AgentState,
	model: ModelClient,
): Promise<Message[]> {
	const systemMessages: Message[] = [];

	if (state.toolPermissionContext.mode === "plan") {
		systemMessages.push({
			role: "system",
			content: getPlanModeReminder(state),
		});
	}

	const memoryPrompt = await loadMemoryPrompt(state.cwd).catch(() => undefined);
	if (memoryPrompt) {
		systemMessages.push({ role: "system", content: memoryPrompt });
	}

	const relevantMemoriesPrompt = await loadRelevantMemoriesPrompt(
		state,
		model,
	).catch(() => "");
	if (relevantMemoriesPrompt) {
		systemMessages.push({ role: "system", content: relevantMemoriesPrompt });
	}

	return [...systemMessages, ...state.messages];
}

async function loadRelevantMemoriesPrompt(
	state: AgentState,
	model: ModelClient,
): Promise<string> {
	const userInput = latestUserInput(state);
	if (!userInput) {
		return "";
	}

	const memories = await scanMemoryFiles(state.cwd);
	if (memories.length === 0) {
		return "";
	}

	const selectionOutput = await collectTextFromModel(
		model,
		buildMemorySelectionMessages({
			userInput,
			manifest: formatMemoryManifest(memories),
		}),
	);
	const selected = parseSelectedMemoryFilenames(selectionOutput, memories);
	if (selected.length === 0) {
		return "";
	}

	const relevant = await readRelevantMemories(memories, selected);
	return formatRelevantMemoriesPrompt(relevant);
}

function latestUserInput(state: AgentState): string {
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const message = state.messages[i];
		if (message?.role === "user") {
			return message.content;
		}
	}
	return "";
}

function shouldRequestMemoryExtraction(state: AgentState): boolean {
	if (state.toolPermissionContext.mode !== "normal") {
		return false;
	}

	let hasAssistant = false;
	let userText = "";
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const message = state.messages[i];
		if (!message) {
			continue;
		}
		if (
			!hasAssistant &&
			message.role === "assistant" &&
			message.content.trim()
		) {
			hasAssistant = true;
			continue;
		}
		if (hasAssistant && message.role === "user") {
			userText = message.content.toLowerCase();
			break;
		}
	}

	if (!hasAssistant || !userText) {
		return false;
	}

	return !(
		userText.includes("don't remember") ||
		userText.includes("do not remember") ||
		userText.includes("不要记") ||
		userText.includes("别记")
	);
}

async function collectTextFromModel(
	model: ModelClient,
	messages: Message[],
): Promise<string> {
	let text = "";
	for await (const event of model.stream({ messages, toolSpecs: [] })) {
		if (event.type === "text_delta") {
			text += event.content;
		}
	}
	return text;
}
