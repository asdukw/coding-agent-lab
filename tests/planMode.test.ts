import { expect, test } from "bun:test";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ModelClient,
	ModelRequest,
	ModelStreamEvent,
} from "../src/model/client";
import { query, type Terminal } from "../src/query";
import {
	createInitialState,
	enterPlanMode,
	resolvePlanApproval,
} from "../src/state";
import { BUILTIN_TOOLS } from "../src/tools";
import {
	EDIT_PLAN_TOOL_NAME,
	ENTER_PLAN_MODE_TOOL_NAME,
	EXIT_PLAN_MODE_TOOL_NAME,
	WRITE_PLAN_TOOL_NAME,
} from "../src/tools/planToolNames";

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cagent-plan-"));
}

class PlanModeModelClient implements ModelClient {
	readonly name = "plan-model";
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
				id: "write-plan",
				name: WRITE_PLAN_TOOL_NAME,
				arguments: JSON.stringify({
					content: "# Plan\n\n- Update the TUI\n- Verify with tests",
				}),
			};
			return;
		}

		yield {
			type: "tool_call",
			id: "exit",
			name: EXIT_PLAN_MODE_TOOL_NAME,
			arguments: "{}",
		};
	}
}

test("plan mode switches tool specs, writes a plan, and pauses for approval", async () => {
	const cwd = await makeTempDir();
	const model = new PlanModeModelClient();
	const initialState = createInitialState("plan a change", cwd);

	let terminal: Terminal | undefined;
	let approvalPlan = "";
	for await (const event of query({
		initialState,
		model,
		tools: BUILTIN_TOOLS,
	})) {
		if (event.type === "plan_approval_request") {
			approvalPlan = event.plan;
		}
		if (event.type === "terminal") {
			terminal = event.terminal;
		}
	}

	expect(terminal?.reason).toBe("plan_approval");
	expect(approvalPlan).toContain("Update the TUI");
	expect(terminal?.state.toolPermissionContext.mode).toBe("plan");
	expect(
		terminal?.state.toolPermissionContext.pendingPlanApproval?.plan,
	).toContain("Verify with tests");

	const planPath = terminal?.state.toolPermissionContext.planFilePath;
	expect(planPath).toBeTruthy();
	if (!planPath || !terminal) {
		throw new Error("expected plan approval terminal state");
	}
	expect(await readFile(planPath, "utf-8")).toContain("Update the TUI");

	const normalToolNames = model.requests[0]?.toolSpecs?.map(
		(tool) => tool.name,
	);
	expect(normalToolNames).toContain(ENTER_PLAN_MODE_TOOL_NAME);
	expect(normalToolNames).not.toContain(EXIT_PLAN_MODE_TOOL_NAME);
	expect(normalToolNames).not.toContain(WRITE_PLAN_TOOL_NAME);

	const planToolNames = model.requests[1]?.toolSpecs?.map((tool) => tool.name);
	expect(planToolNames).toContain(WRITE_PLAN_TOOL_NAME);
	expect(planToolNames).toContain(EDIT_PLAN_TOOL_NAME);
	expect(planToolNames).toContain(EXIT_PLAN_MODE_TOOL_NAME);
	expect(planToolNames).not.toContain("Write");
	expect(planToolNames).not.toContain("Edit");
	expect(model.requests[1]?.messages[0]?.content).toContain(
		"Plan mode is active",
	);

	const approvedState = resolvePlanApproval(terminal.state, "approve");
	expect(approvedState.toolPermissionContext.mode).toBe("normal");
	expect(
		approvedState.toolPermissionContext.pendingPlanApproval,
	).toBeUndefined();
	expect(approvedState.messages.at(-1)?.content).toContain(
		"User approved the plan",
	);
});

class WriteOutsidePlanModelClient implements ModelClient {
	readonly name = "write-outside-plan";
	private callCount = 0;

	constructor(private readonly filePath: string) {}

	async *stream(_request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		this.callCount++;
		if (this.callCount === 1) {
			yield {
				type: "tool_call",
				id: "write",
				name: "Write",
				arguments: JSON.stringify({
					file_path: this.filePath,
					content: "should not be written",
				}),
			};
			return;
		}

		yield { type: "text_delta", content: "still planning" };
	}
}

test("plan mode rejects writes outside the plan file at runtime", async () => {
	const cwd = await makeTempDir();
	const forbiddenPath = join(cwd, "src", "feature.ts");
	const model = new WriteOutsidePlanModelClient(forbiddenPath);
	const initialState = enterPlanMode(createInitialState("plan a change", cwd));

	let terminal: Terminal | undefined;
	for await (const event of query({
		initialState,
		model,
		tools: BUILTIN_TOOLS,
	})) {
		if (event.type === "terminal") {
			terminal = event.terminal;
		}
	}

	expect(terminal?.reason).toBe("complete");
	expect(terminal?.state.observations[0]?.ok).toBe(false);
	expect(terminal?.state.observations[0]?.output).toContain(
		"Plan mode can only write the plan file",
	);
	await expect(access(forbiddenPath)).rejects.toThrow();
});
