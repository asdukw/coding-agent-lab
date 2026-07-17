import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cagent-app-"));
}

test("interactive dialog box drives a multi-turn conversation", async () => {
	const cwd = await makeTempDir();
	const model = new StubModelClient();
	const { lastFrame, stdin, unmount } = render(<App cwd={cwd} model={model} />);

	try {
		await waitForFrame(lastFrame, "Type a message and press Enter...");

		stdin.write("hello there");
		await waitForFrame(lastFrame, "> hello there");

		stdin.write("\r");
		await waitForFrame(lastFrame, [
			"Stub agent received task: hello there",
			"Type a message and press Enter...",
		]);

		let frame = lastFrame() ?? "";
		expect(frame).toContain("user");
		expect(frame).toContain("hello there");
		expect(frame).toContain("Stub agent received task: hello there");
		expect(frame).toContain("Type a message and press Enter...");

		stdin.write("second message");
		await waitForFrame(lastFrame, "> second message");

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
		unmount();
		await rm(cwd, { recursive: true, force: true });
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

	const { lastFrame, stdin, unmount } = render(<App cwd={cwd} model={model} />);

	try {
		stdin.write("/resume resume-1");
		await waitForFrame(lastFrame, "> /resume resume-1");
		stdin.write("\r");
		await waitForFrame(lastFrame, "session: resume-1");

		const frame = lastFrame() ?? "";
		expect(frame).toContain("session: resume-1");
		expect(frame).toContain("old task");
		expect(frame).toContain("old answer");
	} finally {
		unmount();
		await rm(cwd, { recursive: true, force: true });
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
	const { lastFrame, stdin, unmount } = render(<App cwd={cwd} model={model} />);

	try {
		await waitForFrame(lastFrame, "Type a message and press Enter...");
		stdin.write("/plan");
		await waitForFrame(lastFrame, "> /plan");
		stdin.write("\r");
		await waitForFrame(lastFrame, "Entered plan mode");

		const frame = lastFrame() ?? "";
		expect(frame).toContain("user");
		expect(frame).toContain("/plan");
		expect(frame).toContain("Entered plan mode");
		expect(frame).toContain("runtime state only");
		expect(model.called).toBe(false);
	} finally {
		unmount();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("/memory initializes the memory store locally without calling the model", async () => {
	const cwd = await makeTempDir();
	const model = new FailingModelClient();
	const { lastFrame, stdin, unmount } = render(<App cwd={cwd} model={model} />);

	try {
		await waitForFrame(lastFrame, "Type a message and press Enter...");
		stdin.write("/memory");
		await waitForFrame(lastFrame, "> /memory");
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
		unmount();
		await rm(cwd, { recursive: true, force: true });
	}
});

class PlanApprovalModelClient implements ModelClient {
	readonly name = "plan-approval";
	private callCount = 0;

	async *stream(_request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
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
	const { lastFrame, stdin, unmount } = render(<App cwd={cwd} model={model} />);

	try {
		await waitForFrame(lastFrame, "Type a message and press Enter...");
		stdin.write("plan this change");
		await waitForFrame(lastFrame, "> plan this change");
		stdin.write("\r");
		await waitForFrame(lastFrame, "plan approval");

		let frame = lastFrame() ?? "";
		expect(frame).toContain("plan approval");
		expect(frame).toContain("Update approval UI");
		expect(frame).toContain("approve or reject");

		stdin.write("approve");
		await waitForFrame(lastFrame, "> approve");
		stdin.write("\r");
		await waitForFrame(lastFrame, [
			"approve plan",
			"implementation started",
			"Type a message and press Enter...",
		]);

		frame = lastFrame() ?? "";
		expect(frame).toContain("approve plan");
		expect(frame).toContain("implementation started");
	} finally {
		unmount();
		await rm(cwd, { recursive: true, force: true });
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
	const { lastFrame, stdin, unmount } = render(<App cwd={cwd} model={model} />);

	try {
		await waitForFrame(lastFrame, "Type a message and press Enter...");
		stdin.write("write a file");
		await waitForFrame(lastFrame, "> write a file");
		stdin.write("\r");
		await waitForFrame(lastFrame, "tool approval");

		let frame = lastFrame() ?? "";
		expect(frame).toContain("Write");
		expect(frame).toContain("approved.txt");
		expect(frame).toContain("allow, always, or deny");

		stdin.write("allow");
		await waitForFrame(lastFrame, "> allow");
		stdin.write("\r");
		await waitForFrame(lastFrame, [
			"write completed",
			"Type a message and press Enter...",
		]);

		frame = lastFrame() ?? "";
		expect(frame).not.toContain("tool approval");
		expect(await readFile(filePath, "utf8")).toBe("approved content");
	} finally {
		unmount();
		await rm(cwd, { recursive: true, force: true });
	}
});

class BackgroundAgentModelClient implements ModelClient {
	readonly name = "background-agent";
	readonly childEntered = deferredSignal();
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
	const { lastFrame, stdin, unmount } = render(<App cwd={cwd} model={model} />);

	try {
		await waitForFrame(lastFrame, "Type a message and press Enter...");
		stdin.write("delegate this");
		await waitForFrame(lastFrame, "> delegate this");
		stdin.write("\r");
		await waitForSignal(
			model.childEntered.promise,
			lastFrame,
			"child did not start",
		);
		await waitForFrame(lastFrame, "main is idle while child runs");

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
		unmount();
		await rm(cwd, { recursive: true, force: true });
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
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const frame = lastFrame() ?? "";
		if (expectedTexts.every((text) => frame.includes(text))) {
			return;
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(
		`timed out waiting for frame text: ${expectedTexts.join(", ")}; frame=${lastFrame() ?? "<empty>"}`,
	);
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
				}, 2_000);
			}),
		]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}
