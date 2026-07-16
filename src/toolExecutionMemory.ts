import type { Message } from "./state";

const MAX_TOOL_EXECUTIONS = 200;
const MAX_RENDERED_TOOL_EXECUTIONS = 50;
const MAX_TARGET_CHARS = 240;

export type ToolExecutionStatus = "succeeded" | "failed" | "unknown";

/** A bounded working-memory record. Raw arguments and tool outputs stay out. */
export type ToolExecution = {
	callId: string;
	tool: string;
	status: ToolExecutionStatus;
	target?: string;
	turn?: number;
	timestamp?: string;
};

export function recordToolCall(
	executions: readonly ToolExecution[],
	params: {
		callId: string;
		tool: string;
		args?: Record<string, unknown>;
		turn?: number;
		timestamp?: string;
	},
): ToolExecution[] {
	const previous = executions.find(
		(execution) => execution.callId === params.callId,
	);
	return upsertToolExecution(executions, {
		callId: params.callId,
		tool: params.tool,
		status: previous?.status ?? "unknown",
		target: summarizeToolTarget(params.args) ?? previous?.target,
		turn: params.turn ?? previous?.turn,
		timestamp: params.timestamp ?? previous?.timestamp,
	});
}

export function recordToolResult(
	executions: readonly ToolExecution[],
	callId: string,
	ok: boolean,
): ToolExecution[] {
	const index = executions.findIndex(
		(execution) => execution.callId === callId,
	);
	if (index < 0) {
		return executions.slice();
	}

	const next = executions.slice();
	const execution = next[index];
	if (!execution) {
		return next;
	}
	next[index] = {
		...execution,
		status: ok ? "succeeded" : "failed",
	};
	return next;
}

export function recordCompletedToolExecution(
	executions: readonly ToolExecution[],
	params: {
		callId: string;
		tool: string;
		args?: Record<string, unknown>;
		ok: boolean;
		turn?: number;
		timestamp?: string;
	},
): ToolExecution[] {
	return recordToolResult(
		recordToolCall(executions, params),
		params.callId,
		params.ok,
	);
}

export function deriveToolExecutions(
	messages: readonly Message[],
): ToolExecution[] {
	let executions: ToolExecution[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const call of message.toolCalls ?? []) {
				executions = recordToolCall(executions, {
					callId: call.id,
					tool: call.name,
					args: parseToolArguments(call.arguments),
				});
			}
		} else if (message.role === "tool" && message.toolCallId) {
			executions = recordToolResult(
				executions,
				message.toolCallId,
				!message.content.startsWith("error:"),
			);
		}
	}
	return executions;
}

export function formatToolExecutionMemory(
	executions: readonly ToolExecution[],
	messages: readonly Message[],
): string {
	const visibleCallIds = new Set(
		messages.flatMap((message) =>
			message.role === "assistant"
				? (message.toolCalls ?? []).map((call) => call.id)
				: [],
		),
	);
	const remembered = executions
		.filter((execution) => !visibleCallIds.has(execution.callId))
		.slice(-MAX_RENDERED_TOOL_EXECUTIONS);
	if (remembered.length === 0) {
		return "";
	}

	const lines = remembered.map((execution) => {
		const target = execution.target ? `; target=${execution.target}` : "";
		const turn = execution.turn === undefined ? "" : `; turn=${execution.turn}`;
		return `- [${execution.status}] ${execution.tool}${target}${turn}`;
	});
	return [
		"# Session tool execution history",
		"",
		"These records show which tools were invoked earlier in this session. Raw tool outputs are intentionally omitted.",
		"",
		...lines,
	].join("\n");
}

export function parseToolArguments(
	value: string,
): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function upsertToolExecution(
	executions: readonly ToolExecution[],
	execution: ToolExecution,
): ToolExecution[] {
	const next = executions.filter((item) => item.callId !== execution.callId);
	next.push(execution);
	return next.slice(-MAX_TOOL_EXECUTIONS);
}

function summarizeToolTarget(
	args: Record<string, unknown> | undefined,
): string | undefined {
	if (!args) {
		return undefined;
	}
	for (const key of [
		"file_path",
		"path",
		"command",
		"pattern",
		"query",
		"url",
		"cwd",
	]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) {
			return `${key}=${truncateTarget(value)}`;
		}
	}
	return undefined;
}

function truncateTarget(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= MAX_TARGET_CHARS
		? normalized
		: `${normalized.slice(0, MAX_TARGET_CHARS - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
