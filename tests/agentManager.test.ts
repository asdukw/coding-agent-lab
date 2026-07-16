import { expect, test } from "bun:test";
import { z } from "zod";
import { InProcessAgentManager } from "../src/agents/manager";
import type {
	ModelClient,
	ModelRequest,
	ModelStreamEvent,
} from "../src/model/client";
import { createInitialState } from "../src/state";
import { spawnSubagentTool } from "../src/tools/agentTools";
import { runToolCalls } from "../src/tools/runner";
import type { Tool } from "../src/tools/types";

type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

class ImmediateModel implements ModelClient {
	readonly name = "immediate";
	readonly requests: ModelRequest[] = [];

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.requests.push(request);
		const task = latestUserMessage(request);
		yield { type: "text_delta", content: `completed: ${task}` };
	}
}

class ControlledModel implements ModelClient {
	readonly name = "controlled";
	readonly requests: ModelRequest[] = [];
	private readonly gates = new Map<
		string,
		{ entered: Deferred<void>; release: Deferred<void> }
	>();

	add(task: string) {
		const gate = { entered: deferred<void>(), release: deferred<void>() };
		this.gates.set(task, gate);
		return gate;
	}

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.requests.push(request);
		const task = latestUserMessage(request);
		const gate = this.gates.get(task);
		if (!gate) {
			throw new Error(`missing model gate for task: ${task}`);
		}
		gate.entered.resolve();
		await waitForRelease(gate.release.promise, request.signal);
		yield { type: "text_delta", content: `completed: ${task}` };
	}
}

class NonCooperativeModel implements ModelClient {
	readonly name = "non-cooperative";
	readonly entered = deferred<void>();
	readonly release = deferred<void>();

	async *stream(_request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.entered.resolve();
		await this.release.promise;
		yield { type: "text_delta", content: "late completion" };
	}
}

class ResourceToolModel implements ModelClient {
	readonly name = "resource-tool";
	private readonly issued = new Map<string, Deferred<void>>();

	add(task: string): Deferred<void> {
		const signal = deferred<void>();
		this.issued.set(task, signal);
		return signal;
	}

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		const task = latestUserMessage(request);
		if (request.messages.some((message) => message.role === "tool")) {
			yield { type: "text_delta", content: `completed: ${task}` };
			return;
		}
		this.issued.get(task)?.resolve();
		yield {
			type: "tool_call",
			id: `locked-${task}`,
			name: "LockedResource",
			arguments: JSON.stringify({ task }),
		};
	}
}

class ProbeThenThrowModel implements ModelClient {
	readonly name = "probe-then-throw";

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		if (request.messages.some((message) => message.role === "tool")) {
			throw new Error("model failed after probe");
		}
		yield {
			type: "tool_call",
			id: "probe-call",
			name: "Probe",
			arguments: "{}",
		};
	}
}

class ProbeThenBlockModel implements ModelClient {
	readonly name = "probe-then-block";
	readonly blocked = deferred<void>();
	readonly release = deferred<void>();

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		if (request.messages.some((message) => message.role === "tool")) {
			this.blocked.resolve();
			await this.release.promise;
			yield { type: "text_delta", content: "late completion" };
			return;
		}
		yield {
			type: "tool_call",
			id: "probe-before-cancel",
			name: "Probe",
			arguments: "{}",
		};
	}
}

class NestedMemoryModel implements ModelClient {
	readonly name = "nested-memory";
	readonly parentEntered = deferred<void>();
	readonly releaseParent = deferred<void>();

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		const task = latestUserMessage(request);
		if (task === "parent child") {
			this.parentEntered.resolve();
			await this.releaseParent.promise;
			yield { type: "text_delta", content: "parent child complete" };
			return;
		}
		if (request.messages.some((message) => message.role === "tool")) {
			yield { type: "text_delta", content: "grandchild complete" };
			return;
		}
		yield {
			type: "tool_call",
			id: "grandchild-probe",
			name: "Probe",
			arguments: "{}",
		};
	}
}

test("foreground sub-agent returns an isolated result without notifying parent", async () => {
	const model = new ImmediateModel();
	const manager = new InProcessAgentManager({ model, getTools: () => [] });
	const parent = createInitialState("parent", "/repo");

	const response = await manager.spawn(parent, {
		task: "inspect auth",
		description: "inspect",
		agentType: "explore",
	});

	expect(response.status).toBe("completed");
	if (response.status !== "completed") {
		throw new Error("expected foreground completion");
	}
	expect(response.result).toMatchObject({
		status: "completed",
		summary: "completed: inspect auth",
		turnsUsed: 1,
	});
	const [record] = manager.list(parent);
	expect(record).toMatchObject({
		id: response.agentId,
		parentId: parent.agent.id,
		sessionId: parent.sessionId,
		agentType: "explore",
		depth: 1,
		background: false,
		status: "completed",
	});
	expect(record?.startedAt).toBeString();
	expect(record?.completedAt).toBeString();
	expect(manager.drainMessages(parent.agent.id)).toEqual([]);
	await manager.shutdown();
});

test("background agent returns immediately then notifies its parent exactly once", async () => {
	const model = new ControlledModel();
	const gate = model.add("background task");
	const manager = new InProcessAgentManager({ model, getTools: () => [] });
	const parent = createInitialState("parent", "/repo");

	const launched = await manager.spawn(parent, {
		task: "background task",
		runInBackground: true,
	});
	expect(launched.status).toBe("background");
	await gate.entered.promise;
	expect(manager.list(parent)[0]?.status).toBe("running");

	gate.release.resolve();
	const result = await manager.wait(parent, launched.agentId);
	expect(result).toMatchObject({
		status: "completed",
		summary: "completed: background task",
	});
	expect(manager.list(parent)[0]?.status).toBe("completed");
	const notifications = manager.drainMessages(parent.agent.id);
	expect(notifications).toHaveLength(1);
	expect(notifications[0]?.content).toContain(launched.agentId);
	expect(notifications[0]?.content).toContain("completed: background task");

	await manager.wait(parent, launched.agentId);
	expect(manager.drainMessages(parent.agent.id)).toEqual([]);
	await manager.shutdown();
});

test("multiple background agents run concurrently and keep results correlated", async () => {
	const model = new ControlledModel();
	const firstGate = model.add("first task");
	const secondGate = model.add("second task");
	const manager = new InProcessAgentManager({
		model,
		getTools: () => [],
		maxConcurrentAgents: 2,
	});
	const parent = createInitialState("parent", "/repo");

	const first = await manager.spawn(parent, {
		task: "first task",
		runInBackground: true,
	});
	const second = await manager.spawn(parent, {
		task: "second task",
		runInBackground: true,
	});
	await Promise.all([firstGate.entered.promise, secondGate.entered.promise]);

	secondGate.release.resolve();
	firstGate.release.resolve();
	const [firstResult, secondResult] = await Promise.all([
		manager.wait(parent, first.agentId),
		manager.wait(parent, second.agentId),
	]);
	expect(firstResult.summary).toBe("completed: first task");
	expect(secondResult.summary).toBe("completed: second task");
	expect(manager.drainMessages(parent.agent.id)).toHaveLength(2);
	await manager.shutdown();
});

test("cancellation is terminal even if the underlying model later resolves", async () => {
	const model = new ControlledModel();
	const gate = model.add("cancel me");
	const manager = new InProcessAgentManager({ model, getTools: () => [] });
	const parent = createInitialState("parent", "/repo");
	const launched = await manager.spawn(parent, {
		task: "cancel me",
		runInBackground: true,
	});
	await gate.entered.promise;

	expect(
		await manager.cancel(parent, launched.agentId, "no longer needed"),
	).toBe(true);
	const result = await manager.wait(parent, launched.agentId);
	expect(result).toMatchObject({
		status: "cancelled",
		error: "no longer needed",
	});
	gate.release.resolve();
	await Promise.resolve();
	expect(manager.list(parent)[0]?.status).toBe("cancelled");
	expect(await manager.cancel(parent, launched.agentId)).toBe(false);
	expect(manager.drainMessages(parent.agent.id)).toHaveLength(1);
	await manager.shutdown();
});

test("cancellation waits for non-cooperative work to quiesce before becoming terminal", async () => {
	const model = new NonCooperativeModel();
	const manager = new InProcessAgentManager({ model, getTools: () => [] });
	const parent = createInitialState("parent", "/repo");
	const launched = await manager.spawn(parent, {
		task: "ignore cancellation temporarily",
		runInBackground: true,
	});
	await model.entered.promise;

	expect(await manager.cancel(parent, launched.agentId, "stop safely")).toBe(
		true,
	);
	expect(manager.list(parent)[0]?.status).toBe("cancelling");
	let waitSettled = false;
	const resultPromise = manager
		.wait(parent, launched.agentId)
		.then((result) => {
			waitSettled = true;
			return result;
		});
	await Promise.resolve();
	expect(waitSettled).toBe(false);
	expect(manager.drainMessages(parent.agent.id)).toEqual([]);

	model.release.resolve();
	const result = await resultPromise;
	expect(result).toMatchObject({
		status: "cancelled",
		error: "stop safely",
	});
	expect(manager.list(parent)[0]?.status).toBe("cancelled");
	expect(manager.drainMessages(parent.agent.id)).toHaveLength(1);
	await manager.shutdown();
});

test("a cancellation requested during completion wins the terminal race", async () => {
	const model = new NonCooperativeModel();
	const manager = new InProcessAgentManager({ model, getTools: () => [] });
	const parent = createInitialState("parent", "/repo");
	const launched = await manager.spawn(parent, {
		task: "finish with a race",
		runInBackground: true,
	});
	await model.entered.promise;
	let cancellationRequested = false;
	const unsubscribe = manager.subscribe((event) => {
		if (
			event.type === "agent_status" &&
			event.agentId === launched.agentId &&
			event.record?.status === "completing"
		) {
			cancellationRequested = true;
			void manager.cancel(parent, launched.agentId, "terminal race");
		}
	});

	model.release.resolve();
	const result = await manager.wait(parent, launched.agentId);
	unsubscribe();
	expect(cancellationRequested).toBe(true);
	expect(result).toMatchObject({
		status: "cancelled",
		error: "terminal race",
	});
	expect(manager.list(parent)[0]?.status).toBe("cancelled");
	await manager.shutdown();
});

test("messages are rejected after an agent begins committing completion", async () => {
	const model = new NonCooperativeModel();
	const manager = new InProcessAgentManager({ model, getTools: () => [] });
	const parent = createInitialState("parent", "/repo");
	const launched = await manager.spawn(parent, {
		task: "close inbox safely",
		runInBackground: true,
	});
	await model.entered.promise;
	let sendError: Error | undefined;
	const unsubscribe = manager.subscribe((event) => {
		if (
			event.type === "agent_status" &&
			event.agentId === launched.agentId &&
			event.record?.status === "completing"
		) {
			try {
				manager.send(parent, launched.agentId, "too late");
			} catch (caught) {
				sendError =
					caught instanceof Error ? caught : new Error(String(caught));
			}
		}
	});

	model.release.resolve();
	const result = await manager.wait(parent, launched.agentId);
	unsubscribe();
	expect(result.status).toBe("completed");
	expect(sendError?.message).toContain("cannot message");
	expect(manager.hasPendingMessages(launched.agentId)).toBe(false);
	await manager.shutdown();
});

test("concurrent shutdown calls join the same quiescence operation", async () => {
	const model = new NonCooperativeModel();
	const manager = new InProcessAgentManager({ model, getTools: () => [] });
	const parent = createInitialState("parent", "/repo");
	await manager.spawn(parent, {
		task: "block shutdown",
		runInBackground: true,
	});
	await model.entered.promise;

	const firstShutdown = manager.shutdown();
	const secondShutdown = manager.shutdown();
	expect(secondShutdown).toBe(firstShutdown);
	let settled = false;
	void secondShutdown.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);

	model.release.resolve();
	await Promise.all([firstShutdown, secondShutdown]);
	expect(settled).toBe(true);
});

test("a shutdown call re-entered from a status listener joins the same promise", async () => {
	const model = new NonCooperativeModel();
	const manager = new InProcessAgentManager({ model, getTools: () => [] });
	const parent = createInitialState("parent", "/repo");
	await manager.spawn(parent, {
		task: "re-enter shutdown",
		runInBackground: true,
	});
	await model.entered.promise;
	let reentrantShutdown: Promise<void> | undefined;
	manager.subscribe((event) => {
		if (
			event.type === "agent_status" &&
			event.record?.status === "cancelling"
		) {
			reentrantShutdown = manager.shutdown();
		}
	});

	const shutdown = manager.shutdown();
	await Promise.resolve();
	expect(reentrantShutdown).toBe(shutdown);
	model.release.resolve();
	await shutdown;
});

test("a failed sub-agent preserves tools executed before the model error", async () => {
	const probeTool: Tool<Record<string, never>, { ok: true }> = {
		name: "Probe",
		description: "record one successful probe",
		inputSchema: z.object({}),
		getResourceAccesses: () => [],
		async call() {
			return { ok: true };
		},
	};
	const manager = new InProcessAgentManager({
		model: new ProbeThenThrowModel(),
		getTools: () => [probeTool],
	});
	const parent = createInitialState("parent", "/repo");
	parent.toolExecutions = Array.from({ length: 200 }, (_, index) => ({
		callId: `parent-${index}`,
		tool: "Read",
		status: "succeeded" as const,
	}));

	const response = await manager.spawn(parent, { task: "probe then fail" });
	expect(response.status).toBe("completed");
	if (response.status !== "completed") {
		throw new Error("expected foreground response");
	}
	expect(response.result).toMatchObject({
		status: "failed",
		error: "model failed after probe",
		turnsUsed: 2,
	});
	expect(response.result.toolExecutions).toHaveLength(1);
	expect(response.result.toolExecutions[0]).toMatchObject({
		tool: "Probe",
		status: "succeeded",
	});
	const memory = manager.drainMemory(parent.agent.id);
	expect(memory.toolExecutions).toEqual(response.result.toolExecutions);
	await manager.shutdown();
});

test("a cancelled sub-agent preserves tools completed before cancellation", async () => {
	const model = new ProbeThenBlockModel();
	const probeTool: Tool<Record<string, never>, { ok: true }> = {
		name: "Probe",
		description: "record a probe before cancellation",
		inputSchema: z.object({}),
		getResourceAccesses: () => [],
		async call() {
			return { ok: true };
		},
	};
	const manager = new InProcessAgentManager({
		model,
		getTools: () => [probeTool],
	});
	const parent = createInitialState("parent", "/repo");
	const launched = await manager.spawn(parent, {
		task: "probe before cancel",
		runInBackground: true,
	});
	await model.blocked.promise;

	expect(
		await manager.cancel(parent, launched.agentId, "stop after probe"),
	).toBe(true);
	model.release.resolve();
	const result = await manager.wait(parent, launched.agentId);
	expect(result.status).toBe("cancelled");
	expect(result.toolExecutions).toHaveLength(1);
	expect(result.toolExecutions[0]).toMatchObject({
		tool: "Probe",
		status: "succeeded",
	});
	await manager.shutdown();
});

test("nested agent tool memory propagates back to the root runtime", async () => {
	const model = new NestedMemoryModel();
	const probeTool: Tool<Record<string, never>, { ok: true }> = {
		name: "Probe",
		description: "grandchild probe",
		inputSchema: z.object({}),
		getResourceAccesses: () => [],
		async call() {
			return { ok: true };
		},
	};
	const manager = new InProcessAgentManager({
		model,
		getTools: () => [probeTool],
		maxDepth: 2,
	});
	const root = createInitialState("root", "/repo");
	const child = await manager.spawn(root, {
		task: "parent child",
		runInBackground: true,
	});
	await model.parentEntered.promise;
	const childState = createInitialState(
		"child-state",
		"/repo",
		[],
		`${root.sessionId}.agent.${child.agentId}`,
	);
	childState.agent = {
		id: child.agentId,
		parentId: root.agent.id,
		type: "general-purpose",
		depth: 1,
	};

	const grandchild = await manager.spawn(childState, {
		task: "grandchild",
	});
	expect(grandchild.status).toBe("completed");
	model.releaseParent.resolve();
	const childResult = await manager.wait(root, child.agentId);
	expect(childResult.toolExecutions).toHaveLength(1);
	expect(childResult.toolExecutions[0]?.tool).toBe("Probe");
	const rootMemory = manager.drainMemory(root.agent.id);
	expect(rootMemory.toolExecutions).toEqual(childResult.toolExecutions);
	await manager.shutdown();
});

test("fork context inherits structured tool memory but excludes raw tool output", async () => {
	const model = new ImmediateModel();
	const manager = new InProcessAgentManager({ model, getTools: () => [] });
	const parent = createInitialState("parent", "/repo");
	parent.messages.push(
		{
			role: "assistant",
			content: "",
			toolCalls: [
				{ id: "read-1", name: "Read", arguments: '{"file_path":"a.ts"}' },
			],
		},
		{ role: "tool", toolCallId: "read-1", content: "RAW_SECRET_OUTPUT" },
	);
	parent.toolExecutions.push({
		callId: "read-1",
		tool: "Read",
		status: "succeeded",
		target: "file_path=a.ts",
	});

	await manager.spawn(parent, {
		task: "continue inspection",
		contextMode: "fork",
	});

	const serialized = JSON.stringify(model.requests[0]);
	expect(serialized).not.toContain("RAW_SECRET_OUTPUT");
	expect(serialized).toContain("Session tool execution history");
	expect(serialized).toContain("file_path=a.ts");
	await manager.shutdown();
});

test("a sub-agent can send a progress message to the root agent", async () => {
	const model = new ControlledModel();
	const gate = model.add("report progress");
	const manager = new InProcessAgentManager({ model, getTools: () => [] });
	const parent = createInitialState("parent", "/repo");
	parent.agent.id = "root-agent";
	const launched = await manager.spawn(parent, {
		task: "report progress",
		runInBackground: true,
	});
	await gate.entered.promise;

	const child = createInitialState("child", "/repo");
	child.agent = {
		id: launched.agentId,
		parentId: parent.agent.id,
		type: "general-purpose",
		depth: 1,
	};
	manager.send(child, parent.agent.id, "halfway done");

	const [progress] = manager.drainMessages(parent.agent.id);
	expect(progress?.role).toBe("agent");
	expect(progress?.content).toContain(launched.agentId);
	expect(progress?.content).toContain("halfway done");

	gate.release.resolve();
	await manager.wait(parent, launched.agentId);
	await manager.shutdown();
});

test("a sibling agent cannot cancel another sibling", async () => {
	const model = new ControlledModel();
	const firstGate = model.add("first sibling");
	const secondGate = model.add("second sibling");
	const manager = new InProcessAgentManager({
		model,
		getTools: () => [],
		maxConcurrentAgents: 2,
	});
	const parent = createInitialState("parent", "/repo");
	const first = await manager.spawn(parent, {
		task: "first sibling",
		runInBackground: true,
	});
	const second = await manager.spawn(parent, {
		task: "second sibling",
		runInBackground: true,
	});
	await Promise.all([firstGate.entered.promise, secondGate.entered.promise]);
	const firstState = createInitialState("first", "/repo");
	firstState.agent = {
		id: first.agentId,
		parentId: parent.agent.id,
		type: "general-purpose",
		depth: 1,
	};

	await expect(manager.cancel(firstState, second.agentId)).rejects.toThrow(
		"not allowed to cancel",
	);
	firstGate.release.resolve();
	secondGate.release.resolve();
	await Promise.all([
		manager.wait(parent, first.agentId),
		manager.wait(parent, second.agentId),
	]);
	await manager.shutdown();
});

test("cancelling an agent waiting on a shared resource prevents its tool call", async () => {
	const model = new ResourceToolModel();
	const firstIssued = model.add("first locked task");
	const secondIssued = model.add("second locked task");
	const firstEntered = deferred<void>();
	const releaseFirst = deferred<void>();
	const calledTasks: string[] = [];
	const lockedTool: Tool<{ task: string }, { task: string }> = {
		name: "LockedResource",
		description: "hold a shared write resource",
		inputSchema: z.object({ task: z.string() }),
		getResourceAccesses: () => [
			{
				namespace: "runtime",
				key: "agent-manager-shared-resource",
				mode: "write",
			},
		],
		async call(input) {
			calledTasks.push(input.task);
			if (input.task === "first locked task") {
				firstEntered.resolve();
				await releaseFirst.promise;
			}
			return input;
		},
	};
	const manager = new InProcessAgentManager({
		model,
		getTools: () => [lockedTool],
		maxConcurrentAgents: 2,
	});
	const parent = createInitialState("parent", "/repo");

	const first = await manager.spawn(parent, {
		task: "first locked task",
		runInBackground: true,
	});
	await Promise.all([firstIssued.promise, firstEntered.promise]);
	const second = await manager.spawn(parent, {
		task: "second locked task",
		runInBackground: true,
	});
	await secondIssued.promise;

	expect(await manager.cancel(parent, second.agentId, "stop waiting")).toBe(
		true,
	);
	releaseFirst.resolve();
	const [firstResult, secondResult] = await Promise.all([
		manager.wait(parent, first.agentId),
		manager.wait(parent, second.agentId),
	]);
	expect(firstResult.status).toBe("completed");
	expect(secondResult.status).toBe("cancelled");
	expect(calledTasks).toEqual(["first locked task"]);
	await manager.shutdown();
});

test("parallel SpawnSubagent tool calls do not serialize on orchestration locks", async () => {
	const model = new ControlledModel();
	const firstGate = model.add("tool first");
	const secondGate = model.add("tool second");
	const manager = new InProcessAgentManager({
		model,
		getTools: () => [],
		maxConcurrentAgents: 2,
	});
	let state = createInitialState("parent", "/repo");

	const resultsPromise = runToolCalls({
		calls: [
			{
				id: "spawn-1",
				name: "SpawnSubagent",
				arguments: JSON.stringify({ task: "tool first" }),
			},
			{
				id: "spawn-2",
				name: "SpawnSubagent",
				arguments: JSON.stringify({ task: "tool second" }),
			},
		],
		tools: [spawnSubagentTool],
		context: {
			getState: () => state,
			setState(next) {
				state = typeof next === "function" ? next(state) : next;
			},
			agentRuntime: manager,
		},
	});
	await Promise.all([firstGate.entered.promise, secondGate.entered.promise]);
	firstGate.release.resolve();
	secondGate.release.resolve();
	const results = await resultsPromise;
	expect(results.every((result) => result.ok)).toBe(true);
	await manager.shutdown();
});

function latestUserMessage(request: ModelRequest): string {
	for (let index = request.messages.length - 1; index >= 0; index--) {
		const message = request.messages[index];
		if (message?.role === "user") {
			return message.content;
		}
	}
	return "";
}

async function waitForRelease(
	release: Promise<void>,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (!signal) {
		return release;
	}
	if (signal.aborted) {
		throw abortError();
	}
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			release,
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(abortError());
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

function abortError(): Error {
	const error = new Error("aborted");
	error.name = "AbortError";
	return error;
}
