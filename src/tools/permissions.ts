import { isAbsolute, relative, resolve } from "node:path";
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
	args: Record<string, unknown>,
): void {
	if (state.toolPermissionContext.mode !== "plan") {
		if (PLAN_ONLY_TOOL_NAMES.has(tool.name)) {
			throw new Error(`${tool.name} can only be used in plan mode`);
		}
		if (GENERIC_WRITE_TOOL_NAMES.has(tool.name)) {
			authorizeWriteToolCall(state, tool, args);
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

function authorizeWriteToolCall(
	state: AgentState,
	tool: Tool,
	args: Record<string, unknown>,
): void {
	const filePath = args.file_path;
	if (typeof filePath !== "string" || filePath.trim() === "") {
		throw new Error(`${tool.name} requires a file_path for permission checks`);
	}

	const targetPath = resolvePath(state.cwd, filePath);
	if (state.toolPermissionContext.agentType === "memory") {
		const memoryDir = resolve(state.cwd, ".cagent", "memory");
		if (!isPathInside(targetPath, memoryDir)) {
			throw new Error(
				"Memory sub agent can only write files under .cagent/memory",
			);
		}
	}

	const policy = state.toolPermissionContext.writePolicy;
	if (!policy) {
		return;
	}

	const denied = policy.deny?.some((entry) =>
		isPathInside(targetPath, resolvePath(state.cwd, entry)),
	);
	if (denied) {
		throw new Error(`${tool.name} denied by write policy: ${filePath}`);
	}

	if (policy.allow && policy.allow.length > 0) {
		const allowed = policy.allow.some((entry) =>
			isPathInside(targetPath, resolvePath(state.cwd, entry)),
		);
		if (!allowed) {
			throw new Error(
				`${tool.name} is outside allowed write paths: ${filePath}`,
			);
		}
	}
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function isPathInside(targetPath: string, parentPath: string): boolean {
	const child = resolve(targetPath);
	const parent = resolve(parentPath);
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}
