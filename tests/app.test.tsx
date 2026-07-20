import { expect, setDefaultTimeout, test } from "bun:test";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import type {
	ModelClient,
	ModelRequest,
	ModelStreamEvent,
} from "../src/model/client";
import { StubModelClient } from "../src/model/stub";
import { saveSession } from "../src/sessionStore";
import { createInitialState } from "../src/state";
import {
	ENTER_PLAN_MODE_TOOL_NAME,
	EXIT_PLAN_MODE_TOOL_NAME,
	UPDATE_PLAN_TOOL_NAME,
} from "../src/tools/planToolNames";
import { App } from "../src/ui/App";
import { type AppLifecycle, createAppLifecycle } from "../src/ui/appLifecycle";

const APP_WAIT_TIMEOUT_MS = 10_000;

setDefaultTimeout(20_000);

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cagent-app-"));
}

async function removeTempDir(path: string): Promise<void> {
	await rm(path, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 50,
	});
}

async function cleanupApp(
	unmount: () => void,
	lifecycle: AppLifecycle,
	cwd: string,
): Promise<void> {
	unmount();
	await lifecycle.shutdown();
	await removeTempDir(cwd);
}

test("interactive dialog box drives a multi-turn conversation", async () => {
	const cwd = await makeTempDir();
	const model = new StubModelClient();
	const lifecycle = createAppLifecycle();
	const { lastFrame, stdin, unmount } = render(
		<App
			cwd={cwd}
			model={model}
			enableMemoryExtraction={false}
			lifecycle={lifecycle}
		/>,
	);

	try {
		await waitForInputReady(lastFrame, "Type a message and press Enter...");

		stdin.write("hello there");
		await waitForInputValue(
			lastFrame,
			"hello there",
			"Type a message and press Enter...",
		);

		stdin.write("\r");
		await waitForFrame(lastFrame, [
			"Stub agent received task: hello there",
			"Type a message and press Enter...",
		]);
		await waitForInputReady(lastFrame, "Type a message and press Enter...");

		let frame = lastFrame() ?? "";
		expect(frame).toContain("user");
		expect(frame).toContain("hello there");
		expect(frame).toContain("Stub agent received task: hello there");
		expect(frame).toContain("Type a message and press Enter...");

		stdin.write("second message");
		await waitForInputValue(
			lastFrame,
			"second message",
			"Type a message and press Enter...",
		);

		stdin.write("\r");
		await waitForFrame(lastFrame, [
			"Stub agent received task: second message",
			"Type a message and press Enter...",
		]);

		frame = lastFrame() ?? "";
		expect(frame).toContain("hello there");
		expect(frame).toContain("Stub agent received task: hello there");
		expect(frame).toContain("second message");
		expect(frame).toContain("Stub agent received task: second message");
	} finally {
		await cleanupApp(unmount, lifecycle, cwd);
	}
});

test("resume slash command restores a saved session", async () => {
	const cwd = await makeTempDir();
	const model = new StubModelClient();
	const state = {
		...createInitialState("old task", cwd, [], "resume-1"),
		turn: 1,
		budget: {
			turnsUsed: 1,
			maxTurns: 20,
		},
		finalAnswer: "old answer",
		messages: [
			{ role: "user" as const, content: "old task" },
			{ role: "assistant" as const, content: "old answer" },
		],
	};
	await saveSession(cwd, state);

	const lifecycle = createAppLifecycle();
	const { lastFrame, stdin, unmount } = render(
		<App
			cwd={cwd}
			model={model}
			enableMemoryExtraction={false}
			lifecycle={lifecycle}
		/>,
	);

	try {
		await waitForInputReady(lastFrame, "Type a message and press Enter...");
		stdin.write("/resume resume-1");
		await waitForInputValue(
			lastFrame,
			"/resume resume-1",
			"Type a message and press Enter...",
		);
		stdin.write("\r");
		await waitForFrame(lastFrame, "session: resume-1");

		const frame = lastFrame() ?? "";
		expect(frame).toContain("session: resume-1");
		expect(frame).toContain("old task");
		expect(frame).toContain("old answer");
	} finally {
		await cleanupApp(unmount, lifecycle, cwd);
	}
});

test("permissions command opens the picker and supports direct mode changes", async () => {
	const cwd = await makeTempDir();
	const lifecycle = createAppLifecycle();
	const { lastFrame, stdin, unmount } = render(
		<App
			cwd={cwd}
			model={new StubModelClient()}
			enableMemoryExtraction={false}
			lifecycle={lifecycle}
		/>,
	);

	try {
		await waitForInputReady(lastFrame, "Type a message and press Enter...");
		stdin.write("/permissions");
		stdin.write("\r");
		await waitForFrame(lastFrame, "How should cagent actions be approved?");
		expect(lastFrame()).toContain("Approve for me");

		stdin.write("2");
		await waitForFrame(lastFrame, "permissions: auto");
		expect(lastFrame()).toContain(
			"Automatically allow bounded workspace edits",
		);

		await waitForInputReady(lastFrame, "Type a message and press Enter...");
		stdin.write("/permissions full");
		stdin.write("\r");
		await waitForFrame(lastFrame, "permissions: full_access");
	} finally {
		await cleanupApp(unmount, lifecycle, cwd);
	}
});

class FailingModelClient implements ModelClient {
	readonly name = "failing";
	called = false;

	stream(_request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.called = true;
		throw new Error("model should not be called");
	}
}

test("/plan enters plan mode locally without calling the model", async () => {
	const cwd = await makeTempDir();
	const model = new FailingModelClient();
	const lifecycle = createAppLifecycle();
	const { lastFrame, stdin, unmount } = render(
		<App
			cwd={cwd}
			model={model}
			enableMemoryExtraction={false}
			lifecycle={lifecycle}
		/>,
	);

	try {
		await waitForInputReady(lastFrame, "Type a message and press Enter...");
		stdin.write("/plan");
		await waitForInputValue(
			lastFrame,
			"/plan",
			"Type a message and press Enter...",
		);
		stdin.write("\r");
		await waitForFrame(lastFrame, "Entered plan mode");

		const frame = lastFrame() ?? "";
		expect(frame).toContain("user");
		expect(frame).toContain("/plan");
		expect(frame).toContain("Entered plan mode");
		expect(frame).toContain("runtime state only");
		expect(model.called).toBe(false);
	} finally {
		await cleanupApp(unmount, lifecycle, cwd);
	}
});

test("/memory initializes the memory store locally without calling the model", async () => {
	const cwd = await makeTempDir();
	const model = new FailingModelClient();
	const lifecycle = createAppLifecycle();
	const { lastFrame, stdin, unmount } = render(
		<App
			cwd={cwd}
			model={model}
			enableMemoryExtraction={false}
			lifecycle={lifecycle}
		/>,
	);

	try {
		await waitForInputReady(lastFrame, "Type a message and press Enter...");
		stdin.write("/memory");
		await waitForInputValue(
			lastFrame,
			"/memory",
			"Type a message and press Enter...",
		);
		stdin.write("\r");
		await waitForFrame(lastFrame, "Memory store is ready");

		const frame = lastFrame() ?? "";
		expect(frame).toContain("user");
		expect(frame).toContain("/memory");
		expect(frame).toContain("Memory store is ready");
		expect(frame).toContain("MEMORY.md");
		expect(model.called).toBe(false);
		expect(
			await readFile(join(cwd, ".cagent", "memory", "MEMORY.md"), "utf-8"),
		).toBe("# Memory\n\n");
	} finally {
		await cleanupApp(unmount, lifecycle, cwd);
	}
});

class PlanApprovalModelClient implements ModelClient {
	readonly name = "plan-approval";
	readonly requests: ModelRequest[] = [];
	private callCount = 0;

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.requests.push(request);
		this.callCount++;
		if (this.callCount === 1) {
			yield {
				type: "tool_call",
				id: "enter",
				name: ENTER_PLAN_MODE_TOOL_NAME,
				arguments: "{}",
			};
			return;
		}
		if (this.callCount === 2) {
			yield {
				type: "tool_call",
				id: "update-plan",
				name: UPDATE_PLAN_TOOL_NAME,
				arguments: JSON.stringify({
					items: [{ step: "Update approval UI", status: "pending" }],
				}),
			};
			return;
		}
		if (this.callCount === 3) {
			yield {
				type: "tool_call",
				id: "exit",
				name: EXIT_PLAN_MODE_TOOL_NAME,
				arguments: "{}",
			};
			return;
		}

		yield { type: "text_delta", content: "implementation started" };
	}
}

test("plan approval prompt continues after approve", async () => {
	const cwd = await makeTempDir();
	const model = new PlanApprovalModelClient();
	const lifecycle = createAppLifecycle();
	const { lastFrame, stdin, unmount } = render(
		<App
			cwd={cwd}
			model={model}
			enableMemoryExtraction={false}
			lifecycle={lifecycle}
		/>,
	);

	try {
		await waitForInputReady(lastFrame, "Type a message and press Enter...");
		stdin.write("plan this change");
		await waitForInputValue(
			lastFrame,
			"plan this change",
			"Type a message and press Enter...",
		);
		stdin.write("\r");
		await waitForFrame(lastFrame, "plan approval");
		await waitForFrame(lastFrame, "Yes, implement this plan");

		let frame = lastFrame() ?? "";
		expect(frame).toContain("plan approval");
		expect(frame).toContain("Update approval UI");
		expect(frame).toContain("No, keep planning");
		expect(frame).not.toContain("approve or reject with feedback...");

		stdin.write("1");
		await waitForFrame(lastFrame, [
			"approve plan",
			"implementation started",
			"Type a message and press Enter...",
		]);

		frame = lastFrame() ?? "";
		expect(frame).toContain("approve plan");
		expect(frame).toContain("implementation started");
	} finally {
		await cleanupApp(unmount, lifecycle, cwd);
	}
});

test("plan rejection menu collects optional feedback before continuing", async () => {
	const cwd = await makeTempDir();
	const model = new PlanApprovalModelClient();
	const lifecycle = createAppLifecycle();
	const { lastFrame, stdin, unmount } = render(
		<App
			cwd={cwd}
			model={model}
			enableMemoryExtraction={false}
			lifecycle={lifecycle}
		/>,
	);

	try {
		await waitForInputReady(lastFrame, "Type a message and press Enter...");
		stdin.write("plan this change");
		stdin.write("\r");
		await waitForFrame(lastFrame, "No, keep planning");

		stdin.write("2");
		await waitForInputReady(lastFrame, "Describe the changes (optional)...");
		stdin.write("Add a validation step");
		await waitForInputValue(
			lastFrame,
			"Add a validation step",
			"Describe the changes (optional)...",
		);
		stdin.write("\r");

		await waitForFrame(lastFrame, [
			"reject plan: Add a validation step",
			"implementation started",
		]);
		expect(
			model.requests
				.at(-1)
				?.messages.some((message) =>
					message.content.includes("Add a validation step"),
				),
		).toBe(true);
	} finally {
		await cleanupApp(unmount, lifecycle, cwd);
	}
});

class ToolApprovalModelClient implements ModelClient {
	readonly name = "tool-approval";
	private callCount = 0;

	constructor(private readonly filePath: string) {}

	async *stream(_request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.callCount++;
		if (this.callCount === 1) {
			yield {
				type: "tool_call",
				id: "write-approved-file",
				name: "Write",
				arguments: JSON.stringify({
					file_path: this.filePath,
					content: "approved content",
				}),
			};
			return;
		}
		yield { type: "text_delta", content: "write completed" };
	}
}

test("tool approval prompt resumes the original call after allow", async () => {
	const cwd = await makeTempDir();
	const filePath = join(cwd, "approved.txt");
	const model = new ToolApprovalModelClient(filePath);
	const lifecycle = createAppLifecycle();
	const { lastFrame, stdin, unmount } = render(
		<App
			cwd={cwd}
			model={model}
			enableMemoryExtraction={false}
			lifecycle={lifecycle}
		/>,
	);

	try {
		await waitForInputReady(lastFrame, "Type a message and press Enter...");
		stdin.write("write a file");
		await waitForInputValue(
			lastFrame,
			"write a file",
			"Type a message and press Enter...",
		);
		stdin.write("\r");
		await waitForFrame(lastFrame, "tool approval");
		await waitForFrame(lastFrame, "Yes, proceed");

		let frame = lastFrame() ?? "";
		expect(frame).toContain("Write");
		expect(frame).toContain("approved.txt");
		expect(frame).toContain("don't ask again for these tools in this session");
		expect(frame).toContain("No, reject this request");
		expect(frame).not.toContain("allow, always, or deny...");

		stdin.write("1");
		await waitForFrame(lastFrame, [
			"write completed",
			"Type a message and press Enter...",
		]);

		frame = lastFrame() ?? "";
		expect(frame).not.toContain("tool approval");
		expect(await readFile(filePath, "utf8")).toBe("approved content");
	} finally {
		await cleanupApp(unmount, lifecycle, cwd);
	}
});

test("tool approval menu denies the batch with the safe numeric choice", async () => {
	const cwd = await makeTempDir();
	const filePath = join(cwd, "denied.txt");
	const lifecycle = createAppLifecycle();
	const { lastFrame, stdin, unmount } = render(
		<App
			cwd={cwd}
			model={new ToolApprovalModelClient(filePath)}
			enableMemoryExtraction={false}
			lifecycle={lifecycle}
		/>,
	);

	try {
		await waitForInputReady(lastFrame, "Type a message and press Enter...");
		stdin.write("write a file");
		stdin.write("\r");
		await waitForFrame(lastFrame, "No, reject this request");

		stdin.write("3");
		await waitForFrame(lastFrame, [
			"deny tool calls",
			"Type a message and press Enter...",
		]);
		await expect(access(filePath)).rejects.toThrow();
	} finally {
		await cleanupApp(unmount, lifecycle, cwd);
	}
});

class BackgroundAgentModelClient implements ModelClient {
	readonly name = "background-agent";
	readonly childEntered = deferredSignal();
	readonly childAborted = deferredSignal();
	readonly releaseChild = deferredSignal();
	readonly mainRequests: ModelRequest[] = [];
	private mainCallCount = 0;

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		if (
			request.messages.some(
				(message) =>
					message.role === "system" &&
					message.content.includes("working for a parent coding agent"),
			)
		) {
			this.childEntered.resolve();
			const recordAbort = () => this.childAborted.resolve();
			if (request.signal?.aborted) {
				recordAbort();
			} else {
				request.signal?.addEventListener("abort", recordAbort, { once: true });
			}
			await this.releaseChild.promise;
			yield { type: "text_delta", content: "child investigation complete" };
			return;
		}

		if (
			request.messages.some(
				(message) =>
					message.role === "user" &&
					message.content.includes("memory extraction sub-agent"),
			)
		) {
			yield { type: "text_delta", content: "NO_MEMORY" };
			return;
		}

		this.mainRequests.push(request);
		this.mainCallCount++;
		if (this.mainCallCount === 1) {
			yield {
				type: "tool_call",
				id: "spawn-background",
				name: "SpawnSubagent",
				arguments: JSON.stringify({
					task: "investigate in background",
					agent_type: "explore",
					run_in_background: true,
				}),
			};
			return;
		}
		if (this.mainCallCount === 2) {
			yield { type: "text_delta", content: "main is idle while child runs" };
			return;
		}
		yield { type: "text_delta", content: "integrated background result" };
	}
}

test("background completion wakes an idle main agent exactly once", async () => {
	const cwd = await makeTempDir();
	const model = new BackgroundAgentModelClient();
	const lifecycle = createAppLifecycle();
	const { lastFrame, stdin, unmount } = render(
		<App
			cwd={cwd}
			model={model}
			enableMemoryExtraction={false}
			lifecycle={lifecycle}
		/>,
	);

	try {
		await waitForInputReady(lastFrame, "Type a message and press Enter...");
		stdin.write("delegate this");
		await waitForInputValue(
			lastFrame,
			"delegate this",
			"Type a message and press Enter...",
		);
		stdin.write("\r");
		await waitForSignal(
			model.childEntered.promise,
			lastFrame,
			"child did not start",
		);
		await waitForFrame(lastFrame, [
			"main is idle while child runs",
			"Type a message and press Enter...",
		]);

		model.releaseChild.resolve();
		await waitForFrame(lastFrame, "integrated background result");
		await waitForFrame(lastFrame, "Type a message and press Enter...");

		const frame = lastFrame() ?? "";
		expect(frame).toContain("sub-agent notification");
		expect(model.mainRequests).toHaveLength(3);
		expect(JSON.stringify(model.mainRequests[2])).toContain(
			"child investigation complete",
		);
	} finally {
		await cleanupApp(unmount, lifecycle, cwd);
	}
});

test("permission mode changes wait for active background agents to stop", async () => {
	const cwd = await makeTempDir();
	const model = new BackgroundAgentModelClient();
	const lifecycle = createAppLifecycle();
	const initialState = createInitialState("parent", cwd);
	initialState.toolPermissionContext.sessionAllowedTools = ["Write"];
	const { lastFrame, stdin, unmount } = render(
		<App
			cwd={cwd}
			model={model}
			initialState={initialState}
			enableMemoryExtraction={false}
			lifecycle={lifecycle}
		/>,
	);

	try {
		await waitForInputReady(lastFrame, "Type a message and press Enter...");
		stdin.write("delegate this");
		await waitForInputValue(
			lastFrame,
			"delegate this",
			"Type a message and press Enter...",
		);
		stdin.write("\r");
		await waitForSignal(
			model.childEntered.promise,
			lastFrame,
			"child did not start",
		);
		await waitForFrame(lastFrame, [
			"main is idle while child runs",
			"Type a message and press Enter...",
		]);

		stdin.write("/permissions auto");
		await waitForInputValue(
			lastFrame,
			"/permissions auto",
			"Type a message and press Enter...",
		);
		stdin.write("\r");
		await waitForSignal(
			model.childAborted.promise,
			lastFrame,
			"permission change did not cancel the child",
		);
		await waitForFrame(
			lastFrame,
			"Stopping active sub-agents before changing permissions...",
		);
		expect(lastFrame()).toContain("permissions: ask");
		expect(lastFrame()).not.toContain("Type a message and press Enter...");

		model.releaseChild.resolve();
		await waitForFrame(lastFrame, "permissions: auto");
		await waitForInputReady(lastFrame, "Type a message and press Enter...");
	} finally {
		model.releaseChild.resolve();
		await cleanupApp(unmount, lifecycle, cwd);
	}
});

class AbortAwareModelClient implements ModelClient {
	readonly name = "abort-aware";
	readonly entered = deferredSignal();
	aborted = false;

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.entered.resolve();
		await new Promise<void>((_resolve, reject) => {
			const abort = () => {
				this.aborted = true;
				reject(new Error("foreground model aborted"));
			};
			if (request.signal?.aborted) {
				abort();
				return;
			}
			request.signal?.addEventListener("abort", abort, { once: true });
		});
	}
}

test("shutdown aborts and drains an active foreground run", async () => {
	const cwd = await makeTempDir();
	const model = new AbortAwareModelClient();
	const lifecycle = createAppLifecycle();
	const { lastFrame, stdin, unmount } = render(
		<App
			cwd={cwd}
			model={model}
			enableMemoryExtraction={false}
			lifecycle={lifecycle}
		/>,
	);
	let unmounted = false;
	const unmountOnce = () => {
		if (!unmounted) {
			unmounted = true;
			unmount();
		}
	};

	try {
		await waitForInputReady(lastFrame, "Type a message and press Enter...");
		stdin.write("block foreground");
		await waitForInputValue(
			lastFrame,
			"block foreground",
			"Type a message and press Enter...",
		);
		stdin.write("\r");
		await waitForSignal(
			model.entered.promise,
			lastFrame,
			"model did not start",
		);

		unmountOnce();
		await lifecycle.shutdown();
		expect(model.aborted).toBe(true);
	} finally {
		unmountOnce();
		await lifecycle.shutdown();
		await removeTempDir(cwd);
	}
});

class BlockingMemoryExtractionModelClient implements ModelClient {
	readonly name = "blocking-memory-extraction";
	readonly extractionEntered = deferredSignal();
	readonly releaseExtraction = deferredSignal();

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		if (
			request.messages.some(
				(message) =>
					message.role === "user" &&
					message.content.includes("memory extraction sub-agent"),
			)
		) {
			this.extractionEntered.resolve();
			await this.releaseExtraction.promise;
			yield { type: "text_delta", content: "NO_MEMORY" };
			return;
		}

		yield { type: "text_delta", content: "main turn complete" };
	}
}

test("shutdown waits for memory extraction and audit persistence", async () => {
	const cwd = await makeTempDir();
	const model = new BlockingMemoryExtractionModelClient();
	const lifecycle = createAppLifecycle();
	const { lastFrame, stdin, unmount } = render(
		<App cwd={cwd} model={model} lifecycle={lifecycle} />,
	);
	let unmounted = false;
	const unmountOnce = () => {
		if (!unmounted) {
			unmounted = true;
			unmount();
		}
	};

	try {
		await waitForInputReady(lastFrame, "Type a message and press Enter...");
		stdin.write("remember this preference");
		await waitForInputValue(
			lastFrame,
			"remember this preference",
			"Type a message and press Enter...",
		);
		stdin.write("\r");
		await waitForSignal(
			model.extractionEntered.promise,
			lastFrame,
			"memory extraction did not start",
		);
		await waitForFrame(lastFrame, [
			"main turn complete",
			"Type a message and press Enter...",
		]);

		unmountOnce();
		const shutdown = lifecycle.shutdown();
		let shutdownSettled = false;
		void shutdown.then(
			() => {
				shutdownSettled = true;
			},
			() => {
				shutdownSettled = true;
			},
		);
		await nextEventLoopTurn();
		expect(shutdownSettled).toBe(false);

		model.releaseExtraction.resolve();
		await shutdown;
		expect(shutdownSettled).toBe(true);

		const sessionsDir = join(cwd, ".cagent", "sessions");
		const sessionFiles = (await readdir(sessionsDir)).filter(
			(filename) =>
				filename.endsWith(".jsonl") && filename !== "session_index.jsonl",
		);
		expect(sessionFiles).toHaveLength(1);
		expect(
			await readFile(join(sessionsDir, sessionFiles[0] ?? "missing"), "utf8"),
		).toContain('"type":"memory_extraction"');
	} finally {
		model.releaseExtraction.resolve();
		unmountOnce();
		await lifecycle.shutdown();
		await removeTempDir(cwd);
	}
});

function deferredSignal(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

async function waitForFrame(
	lastFrame: () => string | undefined,
	expected: string | readonly string[],
): Promise<void> {
	const expectedTexts = typeof expected === "string" ? [expected] : expected;
	await waitForFrameCondition(
		lastFrame,
		`frame text: ${expectedTexts.join(", ")}`,
		(frame) => expectedTexts.every((text) => frame.includes(text)),
	);
}

async function waitForInputReady(
	lastFrame: () => string | undefined,
	placeholder: string,
): Promise<void> {
	await waitForFrame(lastFrame, placeholder);
	await nextEventLoopTurn();
	await waitForFrame(lastFrame, placeholder);
}

async function waitForInputValue(
	lastFrame: () => string | undefined,
	value: string,
	placeholder: string,
): Promise<void> {
	await waitForFrameCondition(
		lastFrame,
		`input value: ${value}`,
		(frame) => frame.includes(`> ${value}`) && !frame.includes(placeholder),
	);
}

async function waitForFrameCondition(
	lastFrame: () => string | undefined,
	description: string,
	predicate: (frame: string) => boolean,
): Promise<void> {
	const deadline = Date.now() + APP_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const frame = lastFrame() ?? "";
		if (predicate(frame)) {
			return;
		}
		await nextEventLoopTurn();
	}
	throw new Error(
		`timed out waiting for ${description}; frame=${lastFrame() ?? "<empty>"}`,
	);
}

function nextEventLoopTurn(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForSignal(
	promise: Promise<void>,
	lastFrame: () => string | undefined,
	description: string,
): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => {
					reject(
						new Error(`${description}; frame=${lastFrame() ?? "<empty>"}`),
					);
				}, APP_WAIT_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}
