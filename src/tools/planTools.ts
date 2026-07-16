import { z } from "zod";
import { formatPlanMarkdown } from "../plan";
import {
	enterPlanMode,
	requestPlanApproval,
	updateRuntimePlan,
} from "../state";
import {
	ENTER_PLAN_MODE_TOOL_NAME,
	EXIT_PLAN_MODE_TOOL_NAME,
	UPDATE_PLAN_TOOL_NAME,
} from "./planToolNames";
import { sessionResourceAccess } from "./resourceLock";
import type { Tool, ToolContext } from "./types";

function requireContext(context: ToolContext | undefined): ToolContext {
	if (!context) {
		throw new Error("tool context is required");
	}
	return context;
}

const noInputSchema = z.object({});

export const enterPlanModeTool: Tool<
	z.infer<typeof noInputSchema>,
	{ message: string }
> = {
	name: ENTER_PLAN_MODE_TOOL_NAME,
	description:
		"Enter plan mode to inspect the project and prepare a runtime plan before implementation",
	inputSchema: noInputSchema,
	getResourceAccesses(_input, context) {
		return [
			sessionResourceAccess(
				requireContext(context).getState().sessionId,
				"write",
			),
		];
	},
	async call(_input, context) {
		const toolContext = requireContext(context);
		toolContext.setState((state) => enterPlanMode(state));

		return {
			message:
				"Entered plan mode. Inspect the project, update the runtime plan, then call ExitPlanMode for approval.",
		};
	},
};

const planItemSchema = z.object({
	step: z.string().min(1).describe("A concise plan step"),
	status: z
		.enum(["pending", "in_progress", "completed"])
		.describe("Current status for this step"),
});

const updatePlanInputSchema = z.object({
	explanation: z
		.string()
		.optional()
		.describe("Optional short explanation for this plan update"),
	items: z
		.array(planItemSchema)
		.min(1)
		.describe("Ordered plan steps. At most one step can be in_progress."),
});

export const updatePlanTool: Tool<
	z.infer<typeof updatePlanInputSchema>,
	{ plan: string; stepCount: number; message: string }
> = {
	name: UPDATE_PLAN_TOOL_NAME,
	description:
		"Update the runtime plan. Provide the full ordered step list each time; this does not write any local files.",
	inputSchema: updatePlanInputSchema,
	getResourceAccesses(_input, context) {
		return [
			sessionResourceAccess(
				requireContext(context).getState().sessionId,
				"write",
			),
		];
	},
	async call({ explanation, items }, context) {
		const toolContext = requireContext(context);
		const inProgressCount = items.filter(
			(item) => item.status === "in_progress",
		).length;
		if (inProgressCount > 1) {
			throw new Error("only one plan step can be in_progress");
		}

		const runtimePlan = {
			explanation,
			items,
		};
		const plan = formatPlanMarkdown(runtimePlan);
		toolContext.setState((state) => updateRuntimePlan(state, runtimePlan));

		return {
			plan,
			stepCount: items.length,
			message: "Runtime plan updated.",
		};
	},
};

export const exitPlanModeTool: Tool<
	z.infer<typeof noInputSchema>,
	{ plan: string; message: string }
> = {
	name: EXIT_PLAN_MODE_TOOL_NAME,
	description:
		"Present the current runtime plan for user approval and pause before implementation",
	inputSchema: noInputSchema,
	getResourceAccesses(_input, context) {
		return [
			sessionResourceAccess(
				requireContext(context).getState().sessionId,
				"write",
			),
		];
	},
	async call(_input, context) {
		const toolContext = requireContext(context);
		const state = toolContext.getState();
		const plan = formatPlanMarkdown(state.plan);

		if (!plan.trim()) {
			throw new Error("runtime plan is empty; call UpdatePlan first");
		}

		toolContext.setState((current) =>
			requestPlanApproval(current, plan, state.plan),
		);

		return {
			plan,
			message: "Plan is ready for user approval.",
		};
	},
};
