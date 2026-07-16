import { expect, test } from "bun:test";
import { z } from "zod";
import type {
	AgentMemoryUpdate,
	AgentRecord,
	AgentResult,
	AgentRuntime,
	AgentRuntimeListener,
	SpawnAgentRequest,
	SpawnAgentResponse,
} from "../src/agents/types";
import type {
	ModelClient,
	ModelRequest,
	ModelStreamEvent,
} from "../src/model/client";
import { query } from "../src/query";
import {
	type AgentState,
	continueState,
	createInitialState,
	createToolPermissionContext,
	type Message,
} from "../src/state";
import { exitPlanModeTool, updatePlanTool } from "../src/tools/planTools";
import type { Tool } from "../src/tools/types";

class InboxRuntime implements AgentRuntime {
	private messages: Message[] = [];
	private memory: AgentMemoryUpdate = { toolExecutions: [], changedFiles: [] };

	enqueue(message: Message): void {
		this.messages.push(message);
	}

	enqueueMemory(memory: AgentMemoryUpdate): void {
		this.memory = memory;
	}

	spawn(
		_parentState: AgentState,
		_request: SpawnAgentRequest,
	): Promise<SpawnAgentResponse> {
		throw new Error("not implemented");
	}

	list(_requesterState: AgentState): AgentRecord[] {
		return [];
	}

	wait(
		_requesterState: AgentState,
		_agentId: string,
		_timeoutMs?: number,
	): Promise<AgentResult> {
		throw new Error("not implemented");
	}

	send(
		_requesterState: AgentState,
		_agentId: string,
		_content: string,
	): { messageId: string } {
		throw new Error("not implemented");
	}

	cancel(
		_requesterState: AgentState,
		_agentId: string,
		_reason?: string,
	): Promise<boolean> {
		throw new Error("not implemented");
	}

	drainMessages(_agentId: string): Message[] {
		const drained = this.messages;
		this.messages = [];
		return drained;
	}

	drainMemory(_agentId: string): AgentMemoryUpdate {
		const drained = this.memory;
		this.memory = { toolExecutions: [], changedFiles: [] };
		return drained;
	}

	hasPendingMessages(_agentId: string): boolean {
		return this.messages.length > 0;
	}

	subscribe(_listener: AgentRuntimeListener): () => void {
		return () => undefined;
	}

	shutdown(): Promise<void> {
		return Promise.resolve();
	}
}

class TwoToolModel implements ModelClient {
	readonly name = "two-tool";
	readonly requests: ModelRequest[] = [];
	private callCount = 0;

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.requests.push(request);
		this.callCount++;
		if (this.callCount === 1) {
			yield {
				type: "tool_call",
				id: "first",
				name: "controlled",
				arguments: '{"value":"first"}',
			};
			yield {
				type: "tool_call",
				id: "second",
				name: "controlled",
				arguments: '{"value":"second"}',
			};
			return;
		}
		yield { type: "text_delta", content: "handled notification" };
	}
}

class FinalAnswerModel implements ModelClient {
	readonly name = "final-answer";
	readonly requests: ModelRequest[] = [];

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.requests.push(request);
		yield { type: "text_delta", content: "integrated" };
	}
}

class ExitPlanBatchModel implements ModelClient {
	readonly name = "exit-plan-batch";

	async *stream(): AsyncGenerator<ModelStreamEvent> {
		yield {
			type: "tool_call",
			id: "exit-plan",
			name: "ExitPlanMode",
			arguments: "{}",
		};
		yield {
			type: "tool_call",
			id: "read-after-exit",
			name: "Read",
			arguments: "{}",
		};
		yield {
			type: "tool_call",
			id: "update-after-exit",
			name: "UpdatePlan",
			arguments: JSON.stringify({
				items: [{ step: "final plan", status: "pending" }],
			}),
		};
	}
}

test("agent notifications are injected only after every tool result", async () => {
	const runtime = new InboxRuntime();
	const model = new TwoToolModel();
	let entered = 0;
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let bothEntered!: () => void;
	const bothToolsEntered = new Promise<void>((resolve) => {
		bothEntered = resolve;
	});
	const controlledTool: Tool<{ value: string }, { value: string }> = {
		name: "controlled",
		description: "controlled tool",
		inputSchema: z.object({ value: z.string() }),
		getResourceAccesses: () => [],
		async call(input) {
			entered++;
			if (entered === 2) {
				bothEntered();
			}
			await released;
			return input;
		},
	};
	const initialState = createInitialState("start", "/repo");

	const queryPromise = (async () => {
		for await (const _event of query({
			initialState,
			model,
			tools: [controlledTool],
			agentRuntime: runtime,
		})) {
			// Drain the query.
		}
	})();
	await bothToolsEntered;
	runtime.enqueue({
		role: "agent",
		content: '<agent-notification id="child">done</agent-notification>',
	});
	release();
	await queryPromise;

	const secondRequest = model.requests[1];
	expect(secondRequest).toBeDefined();
	const relevant = secondRequest?.messages.slice(-4) ?? [];
	expect(relevant.map((message) => message.role)).toEqual([
		"assistant",
		"tool",
		"tool",
		"agent",
	]);
	expect(relevant[1]?.toolCallId).toBe("first");
	expect(relevant[2]?.toolCallId).toBe("second");
	expect(relevant[3]?.content).toContain("agent-notification");
});

test("an exhausted main budget retains notifications until a real user turn", async () => {
	const runtime = new InboxRuntime();
	runtime.enqueue({
		role: "agent",
		content:
			'<agent-notification>{"summary":"late result"}</agent-notification>',
	});
	const model = new FinalAnswerModel();
	const initialState = createInitialState("start", "/repo");
	initialState.budget = { turnsUsed: 1, maxTurns: 1 };
	let exhaustedState: AgentState | undefined;

	for await (const event of query({
		initialState,
		model,
		tools: [],
		enableMemoryExtraction: false,
		agentRuntime: runtime,
	})) {
		if (event.type === "terminal") {
			expect(event.terminal.reason).toBe("max_turns");
			exhaustedState = event.terminal.state;
		}
	}

	expect(model.requests).toHaveLength(0);
	expect(runtime.hasPendingMessages(initialState.agent.id)).toBe(true);
	if (!exhaustedState) {
		throw new Error("expected exhausted terminal state");
	}
	let resumedState: AgentState | undefined;
	for await (const event of query({
		initialState: continueState(exhaustedState, "integrate the result"),
		model,
		tools: [],
		enableMemoryExtraction: false,
		agentRuntime: runtime,
	})) {
		if (event.type === "terminal") {
			resumedState = event.terminal.state;
		}
	}

	expect(model.requests).toHaveLength(1);
	expect(JSON.stringify(model.requests[0])).toContain("late result");
	expect(resumedState?.finalAnswer).toBe("integrated");
});

test("agent tool memory and changed files merge into the parent structured state", async () => {
	const runtime = new InboxRuntime();
	runtime.enqueueMemory({
		toolExecutions: [
			{
				callId: "child:read-1",
				tool: "Read",
				status: "succeeded",
				target: "file_path=src/auth.ts",
			},
		],
		changedFiles: ["src/auth.ts"],
	});
	const model = new FinalAnswerModel();
	let terminalState: AgentState | undefined;

	for await (const event of query({
		initialState: createInitialState("continue", "/repo"),
		model,
		tools: [],
		enableMemoryExtraction: false,
		agentRuntime: runtime,
	})) {
		if (event.type === "terminal") {
			terminalState = event.terminal.state;
		}
	}

	expect(terminalState?.toolExecutions).toContainEqual({
		callId: "child:read-1",
		tool: "Read",
		status: "succeeded",
		target: "file_path=src/auth.ts",
	});
	expect(terminalState?.changedFiles).toContain("src/auth.ts");
	expect(JSON.stringify(model.requests[0])).toContain(
		"Session tool execution history",
	);
});

test("an agent-only integration turn does not masquerade as a user memory turn", async () => {
	const initialState = createInitialState("original user task", "/repo");
	initialState.messages.push(
		{ role: "assistant", content: "waiting for background work" },
		{ role: "agent", content: "background result" },
	);
	let memoryExtractionRequests = 0;

	for await (const event of query({
		initialState,
		model: new FinalAnswerModel(),
		tools: [],
	})) {
		if (event.type === "memory_extraction_request") {
			memoryExtractionRequests++;
		}
	}

	expect(memoryExtractionRequests).toBe(0);
});

test("plan approval waits until every tool result in the batch is appended", async () => {
	const readTool: Tool<Record<string, never>, { content: string }> = {
		name: "Read",
		description: "read after exit",
		inputSchema: z.object({}),
		getResourceAccesses: () => [],
		async call() {
			return { content: "read completed" };
		},
	};
	const initialState = createInitialState("plan", "/repo");
	initialState.toolPermissionContext = createToolPermissionContext("/repo", {
		mode: "plan",
	});
	initialState.plan = {
		items: [{ step: "inspect", status: "pending" }],
	};
	let terminalState: AgentState | undefined;

	for await (const event of query({
		initialState,
		model: new ExitPlanBatchModel(),
		tools: [exitPlanModeTool, readTool, updatePlanTool],
		enableMemoryExtraction: false,
	})) {
		if (event.type === "terminal") {
			expect(event.terminal.reason).toBe("plan_approval");
			terminalState = event.terminal.state;
		}
	}

	const toolResults = terminalState?.messages.filter(
		(message) => message.role === "tool",
	);
	expect(toolResults?.map((message) => message.toolCallId)).toEqual([
		"exit-plan",
		"read-after-exit",
		"update-after-exit",
	]);
	expect(terminalState?.plan.items).toEqual([
		{ step: "final plan", status: "pending" },
	]);
	expect(
		terminalState?.toolPermissionContext.pendingPlanApproval?.runtimePlan.items,
	).toEqual([{ step: "final plan", status: "pending" }]);
	expect(
		terminalState?.toolPermissionContext.pendingPlanApproval?.plan,
	).toContain("final plan");
});
