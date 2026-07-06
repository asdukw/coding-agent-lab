import { expect, test } from "bun:test";
import { z } from "zod";
import type {
	ModelClient,
	ModelRequest,
	ModelStreamEvent,
} from "../src/model/client";
import { query } from "../src/query";
import { createInitialState } from "../src/state";
import type { Tool } from "../src/tools/types";

const addTool: Tool<{ a: number; b: number }, { sum: number }> = {
	name: "add",
	description: "Add two numbers",
	inputSchema: z.object({ a: z.number(), b: z.number() }),
	async call({ a, b }) {
		return { sum: a + b };
	},
};

class FakeToolCallingModelClient implements ModelClient {
	readonly name = "fake";
	private callCount = 0;

	async *stream(_request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.callCount++;
		if (this.callCount === 1) {
			yield {
				type: "tool_call",
				id: "call_1",
				name: "add",
				arguments: JSON.stringify({ a: 2, b: 3 }),
			};
			return;
		}

		yield { type: "text_delta", content: "The sum is 5" };
	}
}

test("query executes a tool call and round-trips the result back to the model", async () => {
	const model = new FakeToolCallingModelClient();
	const initialState = createInitialState("add 2 and 3", "/repo");

	let terminal;
	for await (const event of query({ initialState, model, tools: [addTool] })) {
		if (event.type === "terminal") {
			terminal = event.terminal;
		}
	}

	expect(terminal?.reason).toBe("complete");
	expect(terminal?.state.finalAnswer).toBe("The sum is 5");

	const toolMessage = terminal?.state.messages.find((m) => m.role === "tool");
	expect(toolMessage?.toolCallId).toBe("call_1");
	expect(toolMessage?.content).toBe(JSON.stringify({ sum: 5 }));

	expect(terminal?.state.observations).toEqual([
		{
			tool: "add",
			args: { a: 2, b: 3 },
			ok: true,
			output: JSON.stringify({ sum: 5 }),
		},
	]);
	expect(terminal?.state.lastToolCall).toEqual({
		name: "add",
		args: { a: 2, b: 3 },
	});
});

test("query feeds an error back as the tool result when the tool is unknown", async () => {
	const model = new FakeToolCallingModelClient();
	const initialState = createInitialState("add 2 and 3", "/repo");

	let terminal;
	for await (const event of query({ initialState, model, tools: [] })) {
		if (event.type === "terminal") {
			terminal = event.terminal;
		}
	}

	const toolMessage = terminal?.state.messages.find((m) => m.role === "tool");
	expect(toolMessage?.content).toBe("error: unknown tool: add");
	expect(terminal?.state.observations[0]?.ok).toBe(false);
});

class FakeInvalidArgsModelClient implements ModelClient {
	readonly name = "fake";
	private callCount = 0;

	async *stream(_request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.callCount++;
		if (this.callCount === 1) {
			yield {
				type: "tool_call",
				id: "call_1",
				name: "add",
				arguments: JSON.stringify({ a: 2 }), // missing required field `b`
			};
			return;
		}

		yield { type: "text_delta", content: "done" };
	}
}

test("query rejects arguments that fail the tool input schema before calling it", async () => {
	let called = false;
	const trackedAddTool: Tool<{ a: number; b: number }, { sum: number }> = {
		...addTool,
		async call(input) {
			called = true;
			return addTool.call(input);
		},
	};

	const model = new FakeInvalidArgsModelClient();
	const initialState = createInitialState("add 2 and 3", "/repo");

	let terminal;
	for await (const event of query({
		initialState,
		model,
		tools: [trackedAddTool],
	})) {
		if (event.type === "terminal") {
			terminal = event.terminal;
		}
	}

	expect(called).toBe(false);
	const toolMessage = terminal?.state.messages.find((m) => m.role === "tool");
	expect(toolMessage?.content).toMatch(/^error:/);
	expect(terminal?.state.observations[0]?.ok).toBe(false);
});
