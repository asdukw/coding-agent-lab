import type {
	ModelClient,
	ModelRequest,
	ModelStreamEvent,
} from "../model/client";
import type { Message } from "../state";
import { DEMO_FILE_PATH } from "./demoFixture";

export const DEMO_SESSION_ID = "offline-demo-v1";
export const DEMO_TASK =
	"Fix the discount calculation in src/price.ts. Inspect the file, propose a plan, wait for approval, then implement and verify the change.";
export const DEMO_RESUME_TASK =
	"Resume this session, read the changed file, and confirm the fix is still present.";
export const DEMO_INITIAL_ANSWER =
	"The discount calculation now subtracts the discount percentage, and the updated file has been verified.";
export const DEMO_RESUME_ANSWER =
	"The restored session retained the change, and src/price.ts still applies the discount correctly.";

export type DemoModelPhase =
	| "enter_plan"
	| "plan_read"
	| "update_plan"
	| "exit_plan"
	| "implementation_read"
	| "edit"
	| "verification_read"
	| "complete"
	| "resume_read"
	| "resume_complete";

export type DemoRequestRecord = {
	phase: DemoModelPhase;
	messageCount: number;
	availableTools: string[];
};

type ScriptedToolCall = Extract<ModelStreamEvent, { type: "tool_call" }>;

const CALLS = {
	enterPlan: toolCall("demo-enter-plan", "EnterPlanMode", {}),
	planRead: toolCall("demo-plan-read", "Read", {
		file_path: DEMO_FILE_PATH,
	}),
	updatePlan: toolCall("demo-update-plan", "UpdatePlan", {
		explanation:
			"Inspect first, then make one bounded correction and verify it.",
		items: [
			{ step: "Inspect the discount calculation", status: "completed" },
			{ step: "Correct and verify the multiplier", status: "pending" },
		],
	}),
	exitPlan: toolCall("demo-exit-plan", "ExitPlanMode", {}),
	implementationRead: toolCall("demo-implementation-read", "Read", {
		file_path: DEMO_FILE_PATH,
	}),
	edit: toolCall("demo-edit", "Edit", {
		file_path: DEMO_FILE_PATH,
		old_string: "1 + discountPercent / 100",
		new_string: "1 - discountPercent / 100",
	}),
	verificationRead: toolCall("demo-verification-read", "Read", {
		file_path: DEMO_FILE_PATH,
	}),
	resumeRead: toolCall("demo-resume-read", "Read", {
		file_path: DEMO_FILE_PATH,
	}),
} as const;

/**
 * A deterministic model used only by the offline demo. It derives its next
 * response from the persisted transcript, so save/load boundaries do not rely
 * on an in-memory call counter.
 */
export class ScriptedDemoModelClient implements ModelClient {
	readonly name = "offline-demo-scripted";
	readonly requests: DemoRequestRecord[] = [];

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		const phase = inferPhase(request.messages);
		this.requests.push({
			phase,
			messageCount: request.messages.length,
			availableTools: (request.toolSpecs ?? []).map((tool) => tool.name).sort(),
		});
		assertToolSurface(request, phase);

		switch (phase) {
			case "enter_plan":
				yield CALLS.enterPlan;
				return;
			case "plan_read":
				yield CALLS.planRead;
				return;
			case "update_plan":
				yield CALLS.updatePlan;
				return;
			case "exit_plan":
				yield CALLS.exitPlan;
				return;
			case "implementation_read":
				yield CALLS.implementationRead;
				return;
			case "edit":
				yield CALLS.edit;
				return;
			case "verification_read":
				yield CALLS.verificationRead;
				return;
			case "complete":
				yield { type: "text_delta", content: DEMO_INITIAL_ANSWER };
				return;
			case "resume_read":
				yield CALLS.resumeRead;
				return;
			case "resume_complete":
				yield { type: "text_delta", content: DEMO_RESUME_ANSWER };
				return;
		}
	}
}

function inferPhase(messages: readonly Message[]): DemoModelPhase {
	if (
		!messages.some(
			(message) => message.role === "user" && message.content === DEMO_TASK,
		)
	) {
		throw new Error("offline demo transcript is missing its initial task");
	}

	const latestUser = findLatestUserMessage(messages);
	if (latestUser?.content === DEMO_RESUME_TASK) {
		return completedSuccessfully(messages, CALLS.resumeRead.id)
			? "resume_complete"
			: "resume_read";
	}

	if (!completedSuccessfully(messages, CALLS.enterPlan.id)) {
		return "enter_plan";
	}
	if (!completedSuccessfully(messages, CALLS.planRead.id)) {
		return "plan_read";
	}
	if (!completedSuccessfully(messages, CALLS.updatePlan.id)) {
		return "update_plan";
	}
	if (!completedSuccessfully(messages, CALLS.exitPlan.id)) {
		return "exit_plan";
	}
	if (!completedSuccessfully(messages, CALLS.implementationRead.id)) {
		return "implementation_read";
	}
	if (!completedSuccessfully(messages, CALLS.edit.id)) {
		return "edit";
	}
	if (!completedSuccessfully(messages, CALLS.verificationRead.id)) {
		return "verification_read";
	}
	return "complete";
}

function completedSuccessfully(
	messages: readonly Message[],
	callId: string,
): boolean {
	const result = messages.find(
		(message) => message.role === "tool" && message.toolCallId === callId,
	);
	if (!result) {
		return false;
	}
	if (result.content.startsWith("error:")) {
		throw new Error(`offline demo tool call failed: ${callId}`);
	}
	return true;
}

function findLatestUserMessage(
	messages: readonly Message[],
): Message | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "user") {
			return message;
		}
	}
	return undefined;
}

function assertToolSurface(request: ModelRequest, phase: DemoModelPhase): void {
	const available = new Set((request.toolSpecs ?? []).map((tool) => tool.name));
	const planPhase =
		phase === "plan_read" || phase === "update_plan" || phase === "exit_plan";
	const required = planPhase
		? ["Read", "UpdatePlan", "ExitPlanMode"]
		: ["Read", "Edit", "EnterPlanMode"];
	const forbidden = planPhase ? ["Edit"] : ["UpdatePlan", "ExitPlanMode"];

	for (const tool of required) {
		if (!available.has(tool)) {
			throw new Error(`offline demo expected the ${tool} tool during ${phase}`);
		}
	}
	for (const tool of forbidden) {
		if (available.has(tool)) {
			throw new Error(
				`offline demo did not expect the ${tool} tool during ${phase}`,
			);
		}
	}
}

function toolCall(
	id: string,
	name: string,
	args: Record<string, unknown>,
): ScriptedToolCall {
	return {
		type: "tool_call",
		id,
		name,
		arguments: JSON.stringify(args),
	};
}
