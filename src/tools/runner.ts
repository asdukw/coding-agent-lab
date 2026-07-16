import type { AgentState, Message, Observation } from "../state";
import { authorizeToolCall } from "./permissions";
import {
	opaqueToolAccess,
	type ResourceAccess,
	type RuntimeResourceLock,
	runtimeResourceLock,
	sessionResourceAccess,
} from "./resourceLock";
import type { Tool, ToolContext, Tools } from "./types";

export type ToolCallRequest = {
	id: string;
	name: string;
	arguments: string;
};

export type ToolCallResult = {
	call: ToolCallRequest;
	ok: boolean;
	args: Record<string, unknown>;
	output: string;
	message: Message;
	observation: Observation;
};

export type ToolStateContext = {
	getState(): AgentState;
	setState(next: AgentState | ((state: AgentState) => AgentState)): void;
};

type PreparedToolCall = {
	call: ToolCallRequest;
	tool: Tool;
	args: Record<string, unknown>;
	accesses: ResourceAccess[];
	callContext: ToolContext;
};

class ToolPreparationError extends Error {
	readonly args: Record<string, unknown>;

	constructor(caught: unknown, args: Record<string, unknown>) {
		super(caught instanceof Error ? caught.message : String(caught));
		this.name = "ToolPreparationError";
		this.args = args;
	}
}

export async function runToolCall({
	call,
	tools,
	context,
	lockManager = runtimeResourceLock,
}: {
	call: ToolCallRequest;
	tools: Tools;
	context: ToolStateContext;
	lockManager?: RuntimeResourceLock;
}): Promise<ToolCallResult> {
	try {
		const prepared = await prepareToolCall(call, tools, context);
		return await executePreparedToolCall(prepared, lockManager);
	} catch (caught) {
		return failedToolCallResult(
			call,
			caught instanceof ToolPreparationError ? caught.args : {},
			caught,
		);
	}
}

export async function runToolCalls({
	calls,
	tools,
	context,
	lockManager = runtimeResourceLock,
}: {
	calls: readonly ToolCallRequest[];
	tools: Tools;
	context: ToolStateContext;
	lockManager?: RuntimeResourceLock;
}): Promise<ToolCallResult[]> {
	const prepared: Array<PreparedToolCall | ToolCallResult> = [];
	for (const call of calls) {
		try {
			const next = await prepareToolCall(call, tools, context);
			prepared.push(next);
		} catch (caught) {
			prepared.push(
				failedToolCallResult(
					call,
					caught instanceof ToolPreparationError ? caught.args : {},
					caught,
				),
			);
		}
	}

	return Promise.all(
		prepared.map((item) =>
			"ok" in item ? item : executePreparedToolCall(item, lockManager),
		),
	);
}

async function prepareToolCall(
	call: ToolCallRequest,
	tools: Tools,
	context: ToolStateContext,
): Promise<PreparedToolCall> {
	let args: Record<string, unknown> = {};
	try {
		const tool = tools.find((candidate) => candidate.name === call.name);
		if (!tool) {
			throw new Error(`unknown tool: ${call.name}`);
		}

		args = tool.inputSchema.parse(JSON.parse(call.arguments)) as Record<
			string,
			unknown
		>;
		await authorizeToolCall(context.getState(), tool, args);
		const callContext = toolContext(context);
		const declaredAccesses = tool.getResourceAccesses
			? await tool.getResourceAccesses(args, callContext)
			: [opaqueToolAccess()];
		return {
			call,
			tool,
			args,
			accesses: withSessionReadAccess(
				declaredAccesses,
				context.getState().sessionId,
			),
			callContext,
		};
	} catch (caught) {
		throw new ToolPreparationError(caught, args);
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	lockManager: RuntimeResourceLock,
): Promise<ToolCallResult> {
	try {
		const release = await lockManager.acquire(prepared.accesses);
		try {
			const result = await prepared.tool.call(
				prepared.args,
				prepared.callContext,
			);
			return successfulToolCallResult(
				prepared.call,
				prepared.args,
				JSON.stringify(result),
			);
		} finally {
			release();
		}
	} catch (caught) {
		return failedToolCallResult(prepared.call, prepared.args, caught);
	}
}

function successfulToolCallResult(
	call: ToolCallRequest,
	args: Record<string, unknown>,
	output: string,
): ToolCallResult {
	return createToolCallResult(call, args, true, output);
}

function failedToolCallResult(
	call: ToolCallRequest,
	args: Record<string, unknown>,
	caught: unknown,
): ToolCallResult {
	return createToolCallResult(
		call,
		args,
		false,
		`error: ${caught instanceof Error ? caught.message : String(caught)}`,
	);
}

function createToolCallResult(
	call: ToolCallRequest,
	args: Record<string, unknown>,
	ok: boolean,
	output: string,
): ToolCallResult {
	const message: Message = {
		role: "tool",
		content: output,
		toolCallId: call.id,
	};
	const observation: Observation = {
		tool: call.name,
		args,
		ok,
		output,
	};
	return { call, ok, args, output, message, observation };
}

function toolContext(context: ToolStateContext): ToolContext {
	return {
		getState: context.getState,
		setState: context.setState,
	};
}

function withSessionReadAccess(
	accesses: readonly ResourceAccess[],
	sessionId: string,
): ResourceAccess[] {
	if (
		accesses.some(
			(access) => access.namespace === "session" && access.key === sessionId,
		)
	) {
		return accesses.slice();
	}
	return [...accesses, sessionResourceAccess(sessionId, "read")];
}
