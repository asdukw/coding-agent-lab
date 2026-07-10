import type { AgentState, Message, Observation } from "../state";
import { authorizeToolCall } from "./permissions";
import type { ToolContext, Tools } from "./types";

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

export async function runToolCall({
	call,
	tools,
	context,
}: {
	call: ToolCallRequest;
	tools: Tools;
	context: ToolStateContext;
}): Promise<ToolCallResult> {
	let ok = true;
	let output: string;
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
		const result = await tool.call(args, toolContext(context));
		output = JSON.stringify(result);
	} catch (caught) {
		ok = false;
		output = `error: ${caught instanceof Error ? caught.message : String(caught)}`;
	}

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

	return {
		call,
		ok,
		args,
		output,
		message,
		observation,
	};
}

export async function runToolCalls({
	calls,
	tools,
	context,
}: {
	calls: readonly ToolCallRequest[];
	tools: Tools;
	context: ToolStateContext;
}): Promise<ToolCallResult[]> {
	const results: ToolCallResult[] = [];
	for (const call of calls) {
		results.push(await runToolCall({ call, tools, context }));
	}
	return results;
}

function toolContext(context: ToolStateContext): ToolContext {
	return {
		getState: context.getState,
		setState: context.setState,
	};
}
