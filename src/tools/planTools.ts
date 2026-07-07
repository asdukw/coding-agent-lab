import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { enterPlanMode, requestPlanApproval } from "../state";
import {
	EDIT_PLAN_TOOL_NAME,
	ENTER_PLAN_MODE_TOOL_NAME,
	EXIT_PLAN_MODE_TOOL_NAME,
	WRITE_PLAN_TOOL_NAME,
} from "./planToolNames";
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
	{ message: string; planFilePath: string }
> = {
	name: ENTER_PLAN_MODE_TOOL_NAME,
	description:
		"Enter plan mode to inspect the project and write a plan before implementation",
	inputSchema: noInputSchema,
	async call(_input, context) {
		const toolContext = requireContext(context);
		toolContext.setState((state) => enterPlanMode(state));
		const state = toolContext.getState();

		return {
			message:
				"Entered plan mode. Inspect the project, write the plan file, then call ExitPlanMode for approval.",
			planFilePath: state.toolPermissionContext.planFilePath,
		};
	},
};

const writePlanInputSchema = z.object({
	content: z.string().describe("Full markdown plan content"),
});

export const writePlanTool: Tool<
	z.infer<typeof writePlanInputSchema>,
	{ filePath: string; bytesWritten: number }
> = {
	name: WRITE_PLAN_TOOL_NAME,
	description:
		"Write or replace the current plan file. This is the only write tool available in plan mode.",
	inputSchema: writePlanInputSchema,
	async call({ content }, context) {
		const toolContext = requireContext(context);
		const filePath = toolContext.getState().toolPermissionContext.planFilePath;
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, content, "utf-8");

		return {
			filePath,
			bytesWritten: Buffer.byteLength(content, "utf-8"),
		};
	},
};

const editPlanInputSchema = z.object({
	old_string: z.string().describe("Exact plan text to find and replace"),
	new_string: z.string().describe("Text to replace it with"),
	replace_all: z
		.boolean()
		.optional()
		.describe("Replace every occurrence instead of requiring exactly one"),
});

export const editPlanTool: Tool<
	z.infer<typeof editPlanInputSchema>,
	{ filePath: string; replacements: number }
> = {
	name: EDIT_PLAN_TOOL_NAME,
	description: "Find and replace text in the current plan file",
	inputSchema: editPlanInputSchema,
	async call({ old_string, new_string, replace_all }, context) {
		const toolContext = requireContext(context);
		const filePath = toolContext.getState().toolPermissionContext.planFilePath;
		const text = await readFile(filePath, "utf-8");
		const occurrences = text.split(old_string).length - 1;

		if (occurrences === 0) {
			throw new Error(`old_string not found in ${filePath}`);
		}
		if (!replace_all && occurrences > 1) {
			throw new Error(
				`old_string matched ${occurrences} times in ${filePath}; pass replace_all or make old_string unique`,
			);
		}

		const replacements = replace_all ? occurrences : 1;
		const updated = replace_all
			? text.split(old_string).join(new_string)
			: text.replace(old_string, new_string);

		await writeFile(filePath, updated, "utf-8");
		return { filePath, replacements };
	},
};

export const exitPlanModeTool: Tool<
	z.infer<typeof noInputSchema>,
	{ plan: string; planFilePath: string; message: string }
> = {
	name: EXIT_PLAN_MODE_TOOL_NAME,
	description:
		"Present the current plan for user approval and pause before implementation",
	inputSchema: noInputSchema,
	async call(_input, context) {
		const toolContext = requireContext(context);
		const state = toolContext.getState();
		const planFilePath = state.toolPermissionContext.planFilePath;
		const plan = await readFile(planFilePath, "utf-8");

		if (!plan.trim()) {
			throw new Error(`plan file is empty: ${planFilePath}`);
		}

		toolContext.setState((current) =>
			requestPlanApproval(current, plan, planFilePath),
		);

		return {
			plan,
			planFilePath,
			message: "Plan is ready for user approval.",
		};
	},
};
