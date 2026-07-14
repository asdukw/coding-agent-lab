import type { ModelClient } from "./model/client";
import type { AgentState, Message } from "./state";

const DEFAULT_MAX_CONTEXT_CHARS = 48_000;
const DEFAULT_RETAIN_RECENT_TURNS = 2;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_COMPACTION_SOURCE_CHARS = 96_000;
const MAX_SUMMARY_CHARS = 16_000;

export type AutoCompactOptions = {
	maxContextChars?: number;
	retainRecentTurns?: number;
};

export type AutoCompactOutcome = {
	state: AgentState;
	didCompact: boolean;
	failure?: string;
};

type CompactionSelection = {
	toCompact: Message[];
	retained: Message[];
};

/**
 * Mirrors cc-haha's auto-compact boundary: this is an internal query-loop
 * operation, not a model-invocable tool. It only replaces history after a
 * valid summary has been produced.
 */
export async function autoCompactIfNeeded(
	state: AgentState,
	model: ModelClient,
	options: AutoCompactOptions = {},
): Promise<AutoCompactOutcome> {
	if (!shouldAutoCompact(state, options)) {
		return { state, didCompact: false };
	}

	const selection = selectMessagesForCompaction(
		state.messages,
		options.retainRecentTurns ?? DEFAULT_RETAIN_RECENT_TURNS,
	);
	if (!selection) {
		return { state, didCompact: false };
	}

	try {
		const summary = await summarizeMessages(selection.toCompact, state, model);
		const compactedState: AgentState = {
			...state,
			messages: [
				createCompactionSummaryMessage(summary),
				...selection.retained,
			],
			compaction: { consecutiveFailures: 0 },
		};
		return { state: compactedState, didCompact: true };
	} catch (caught) {
		return {
			state: {
				...state,
				compaction: {
					consecutiveFailures: state.compaction.consecutiveFailures + 1,
				},
			},
			didCompact: false,
			failure: formatCaught(caught),
		};
	}
}

export function shouldAutoCompact(
	state: AgentState,
	options: AutoCompactOptions = {},
): boolean {
	if (process.env.CAGENT_AUTO_COMPACT === "0") {
		return false;
	}
	if (state.toolPermissionContext.agentType === "memory") {
		return false;
	}
	if (state.compaction.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
		return false;
	}

	return (
		estimateMessageChars(state.messages) >
		(options.maxContextChars ?? configuredMaxContextChars())
	);
}

export function estimateMessageChars(messages: readonly Message[]): number {
	return messages.reduce((total, message) => {
		const toolCallChars = message.toolCalls
			? JSON.stringify(message.toolCalls).length
			: 0;
		return total + message.content.length + toolCallChars;
	}, 0);
}

export function selectMessagesForCompaction(
	messages: readonly Message[],
	retainRecentTurns = DEFAULT_RETAIN_RECENT_TURNS,
): CompactionSelection | undefined {
	const safeRetainTurns = Math.max(1, Math.floor(retainRecentTurns));
	const userMessageIndexes = messages.flatMap((message, index) =>
		message.role === "user" ? [index] : [],
	);
	if (userMessageIndexes.length <= safeRetainTurns) {
		return undefined;
	}

	const retainedStart = userMessageIndexes.at(-safeRetainTurns);
	if (retainedStart === undefined || retainedStart === 0) {
		return undefined;
	}

	return {
		toCompact: messages.slice(0, retainedStart),
		retained: messages.slice(retainedStart),
	};
}

export function createCompactionSummaryMessage(summary: string): Message {
	return {
		role: "system",
		content: `## Auto-compacted conversation summary\n\n${summary.trim()}`,
	};
}

async function summarizeMessages(
	messages: readonly Message[],
	state: AgentState,
	model: ModelClient,
): Promise<string> {
	let summary = "";
	for await (const event of model.stream({
		messages: [
			{
				role: "system",
				content:
					"Summarize the prior coding-agent conversation for continuation. Preserve the user's goal, confirmed facts, decisions, constraints, changed files, commands/tests and results, current plan/todos, and unresolved work. Do not invent facts. Return only a concise durable summary; do not call tools.",
			},
			{
				role: "user",
				content: formatCompactionSource(messages, state),
			},
		],
		toolSpecs: [],
	})) {
		if (event.type === "tool_call") {
			throw new Error("compaction model attempted to call a tool");
		}
		summary += event.content;
	}

	const trimmed = summary.trim();
	if (!trimmed) {
		throw new Error("compaction model returned an empty summary");
	}
	return trimText(trimmed, MAX_SUMMARY_CHARS);
}

function formatCompactionSource(
	messages: readonly Message[],
	state: AgentState,
): string {
	const transcript = messages
		.map((message) => {
			const toolCalls = message.toolCalls?.length
				? `\nTool calls: ${JSON.stringify(message.toolCalls)}`
				: "";
			return `[${message.role.toUpperCase()}]\n${message.content}${toolCalls}`;
		})
		.join("\n\n");
	const runtime = JSON.stringify({ plan: state.plan, todos: state.todos });
	return trimText(
		`Current runtime state:\n${runtime}\n\nConversation to summarize:\n${transcript}`,
		MAX_COMPACTION_SOURCE_CHARS,
	);
}

function configuredMaxContextChars(): number {
	const configured = Number.parseInt(
		process.env.CAGENT_AUTO_COMPACT_MAX_CHARS ?? "",
		10,
	);
	return configured > 0 ? configured : DEFAULT_MAX_CONTEXT_CHARS;
}

function trimText(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}
	const half = Math.floor((maxChars - 64) / 2);
	return `${value.slice(0, half)}\n\n[... middle omitted for compaction ...]\n\n${value.slice(-half)}`;
}

function formatCaught(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}
