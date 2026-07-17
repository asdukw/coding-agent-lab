import type { AgentRuntime } from "../agents/types";
import type { AgentState, Message, Observation } from "../state";
import { authorizeToolCall } from "./permissions";
import {
	opaqueToolAccess,
	type ResourceAccess,
	type RuntimeResourceLock,
	resourceAccessSetsEqual,
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
	agentRuntime?: AgentRuntime;
	signal?: AbortSignal;
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
	signal,
}: {
	call: ToolCallRequest;
	tools: Tools;
	context: ToolStateContext;
	lockManager?: RuntimeResourceLock;
	signal?: AbortSignal;
}): Promise<ToolCallResult> {
	try {
		const prepared = await prepareToolCall(call, tools, context);
		return await executePreparedToolCall(prepared, lockManager, signal);
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
	signal,
}: {
	calls: readonly ToolCallRequest[];
	tools: Tools;
	context: ToolStateContext;
	lockManager?: RuntimeResourceLock;
	signal?: AbortSignal;
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
			"ok" in item ? item : executePreparedToolCall(item, lockManager, signal),
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
		return {
			call,
			tool,
			args,
			accesses: await planToolAccesses(tool, args, callContext),
			callContext,
		};
	} catch (caught) {
		throw new ToolPreparationError(caught, args);
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	lockManager: RuntimeResourceLock,
	signal?: AbortSignal,
): Promise<ToolCallResult> {
	try {
		let accesses = prepared.accesses;
		for (;;) {
			const release = await lockManager.acquire(accesses, signal);
			try {
				throwIfAborted(signal);
				// Preparation can happen concurrently for a whole model response. Recheck
				// permissions only after the session/resource lease is held so an earlier
				// state-changing tool (for example EnterPlanMode) cannot leave this call
				// executing under a stale authorization decision.
				await authorizeToolCall(
					prepared.callContext.getState(),
					prepared.tool,
					prepared.args,
				);

				// An opaque Shell/MCP call can change a symlink or directory between the
				// initial realpath lookup and lease acquisition. Re-plan while holding the
				// opaque barrier; if identity changed, release and atomically reacquire the
				// new complete resource set before executing.
				const currentAccesses = await planToolAccesses(
					prepared.tool,
					prepared.args,
					prepared.callContext,
				);
				if (!resourceAccessSetsEqual(accesses, currentAccesses)) {
					accesses = currentAccesses;
					continue;
				}

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
		}
	} catch (caught) {
		return failedToolCallResult(prepared.call, prepared.args, caught);
	}
}

async function planToolAccesses(
	tool: Tool,
	args: Record<string, unknown>,
	context: ToolContext,
): Promise<ResourceAccess[]> {
	const declaredAccesses = tool.getResourceAccesses
		? await tool.getResourceAccesses(args, context)
		: [opaqueToolAccess()];
	return withSessionReadAccess(
		withOpaqueToolBarrier(declaredAccesses),
		context.getState().sessionId,
	);
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
		agentRuntime: context.agentRuntime,
		signal: context.signal,
	};
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) {
		return;
	}
	const error = new Error(
		typeof signal.reason === "string" ? signal.reason : "tool call aborted",
	);
	error.name = "AbortError";
	throw error;
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

/**
 * Concrete tools share the read side of the global opaque-tool barrier. A tool
 * whose effects cannot be mapped to concrete resources takes its write side,
 * making that call exclusive without disabling safe resource-level parallelism.
 */
function withOpaqueToolBarrier(
	accesses: readonly ResourceAccess[],
): ResourceAccess[] {
	if (
		accesses.some(
			(access) =>
				access.namespace === "runtime" && access.key === "opaque-tools",
		)
	) {
		return accesses.slice();
	}
	return [...accesses, opaqueToolAccess("read")];
}
