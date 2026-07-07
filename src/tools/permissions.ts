import type { AgentState } from "../state";
import {
	ENTER_PLAN_MODE_TOOL_NAME,
	EXIT_PLAN_MODE_TOOL_NAME,
	UPDATE_PLAN_TOOL_NAME,
} from "./planToolNames";
import type { Tool, Tools } from "./types";

const READ_ONLY_TOOL_NAMES = new Set(["Read", "Glob", "Grep"]);
const GENERIC_WRITE_TOOL_NAMES = new Set(["Write", "Edit"]);
const PLAN_ONLY_TOOL_NAMES = new Set([
	EXIT_PLAN_MODE_TOOL_NAME,
	UPDATE_PLAN_TOOL_NAME,
]);
const PLAN_MODE_TOOL_NAMES = new Set([
	"Read",
	"Glob",
	"Grep",
	UPDATE_PLAN_TOOL_NAME,
	EXIT_PLAN_MODE_TOOL_NAME,
	ENTER_PLAN_MODE_TOOL_NAME,
]);

export function getToolsForMode(state: AgentState, tools: Tools): Tools {
	if (state.toolPermissionContext.mode !== "plan") {
		return tools.filter((tool) => !PLAN_ONLY_TOOL_NAMES.has(tool.name));
	}

	return tools.filter((tool) => {
		if (tool.name === "Write" || tool.name === "Edit") {
			return false;
		}
		return PLAN_MODE_TOOL_NAMES.has(tool.name);
	});
}

export function authorizeToolCall(
	state: AgentState,
	tool: Tool,
	_args: Record<string, unknown>,
): void {
	if (state.toolPermissionContext.mode !== "plan") {
		if (PLAN_ONLY_TOOL_NAMES.has(tool.name)) {
			throw new Error(`${tool.name} can only be used in plan mode`);
		}
		return;
	}

	if (
		READ_ONLY_TOOL_NAMES.has(tool.name) ||
		tool.name === ENTER_PLAN_MODE_TOOL_NAME ||
		tool.name === EXIT_PLAN_MODE_TOOL_NAME ||
		tool.name === UPDATE_PLAN_TOOL_NAME
	) {
		return;
	}

	if (GENERIC_WRITE_TOOL_NAMES.has(tool.name)) {
		throw new Error("Plan mode cannot write local files; use UpdatePlan");
	}

	throw new Error(`${tool.name} is not allowed in plan mode`);
}
