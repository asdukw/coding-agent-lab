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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cagent-app-"));
}

test("interactive dialog box drives a multi-turn conversation", async () => {
	const cwd = await makeTempDir();
	const model = new StubModelClient();
	const { lastFrame, stdin, unmount } = render(<App cwd={cwd} model={model} />);

	try {
		await wait(100);
		expect(lastFrame()).toContain("Type a message and press Enter...");

		stdin.write("hello there");
		await wait(100);
		expect(lastFrame()).toContain("hello there");

		stdin.write("\r");
		await wait(300);

		let frame = lastFrame() ?? "";
		expect(frame).toContain("user");
		expect(frame).toContain("hello there");
		expect(frame).toContain("Stub agent received task: hello there");
		expect(frame).toContain("Type a message and press Enter...");

		stdin.write("second message");
		await wait(100);
		expect(lastFrame()).toContain("second message");

		stdin.write("\r");
		await wait(300);

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
		await wait(100);
		stdin.write("\r");
		await wait(300);

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
		await wait(100);
		stdin.write("/plan");
		await wait(100);
		stdin.write("\r");
		await wait(300);

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
		await wait(100);
		stdin.write("/memory");
		await wait(100);
		stdin.write("\r");
		await wait(300);

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
		await wait(100);
		stdin.write("plan this change");
		await wait(100);
		stdin.write("\r");
		await wait(500);

		let frame = lastFrame() ?? "";
		expect(frame).toContain("plan approval");
		expect(frame).toContain("Update approval UI");
		expect(frame).toContain("approve or reject");

		stdin.write("approve");
		await wait(100);
		stdin.write("\r");
		await wait(500);

		frame = lastFrame() ?? "";
		expect(frame).toContain("approve plan");
		expect(frame).toContain("implementation started");
	} finally {
		unmount();
		await rm(cwd, { recursive: true, force: true });
	}
});
