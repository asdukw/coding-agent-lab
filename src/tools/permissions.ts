import { isAbsolute, resolve } from "node:path";
import { isMemoryIndexPath, resolveMemoryWriteTarget } from "../memory";
import {
	isPathInside,
	resolveContainedWritePath,
	resolveRealPathForWrite,
} from "../pathSafety";
import type { AgentState } from "../state";
import {
	CANCEL_AGENT_TOOL_NAME,
	LIST_AGENTS_TOOL_NAME,
	SEND_AGENT_MESSAGE_TOOL_NAME,
	WAIT_AGENT_TOOL_NAME,
} from "./agentToolNames";
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
	LIST_AGENTS_TOOL_NAME,
	WAIT_AGENT_TOOL_NAME,
	SEND_AGENT_MESSAGE_TOOL_NAME,
	CANCEL_AGENT_TOOL_NAME,
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

export async function authorizeToolCall(
	state: AgentState,
	tool: Tool,
	args: Record<string, unknown>,
): Promise<void> {
	if (state.toolPermissionContext.mode !== "plan") {
		if (PLAN_ONLY_TOOL_NAMES.has(tool.name)) {
			throw new Error(`${tool.name} can only be used in plan mode`);
		}
		if (GENERIC_WRITE_TOOL_NAMES.has(tool.name)) {
			await authorizeWriteToolCall(state, tool, args);
		}
		return;
	}

	if (
		READ_ONLY_TOOL_NAMES.has(tool.name) ||
		tool.name === ENTER_PLAN_MODE_TOOL_NAME ||
		tool.name === EXIT_PLAN_MODE_TOOL_NAME ||
		tool.name === UPDATE_PLAN_TOOL_NAME ||
		tool.name === LIST_AGENTS_TOOL_NAME ||
		tool.name === WAIT_AGENT_TOOL_NAME ||
		tool.name === SEND_AGENT_MESSAGE_TOOL_NAME ||
		tool.name === CANCEL_AGENT_TOOL_NAME
	) {
		return;
	}

	if (GENERIC_WRITE_TOOL_NAMES.has(tool.name)) {
		throw new Error("Plan mode cannot write local files; use UpdatePlan");
	}

	throw new Error(`${tool.name} is not allowed in plan mode`);
}

async function authorizeWriteToolCall(
	state: AgentState,
	tool: Tool,
	args: Record<string, unknown>,
): Promise<void> {
	const filePath = args.file_path;
	if (typeof filePath !== "string" || filePath.trim() === "") {
		throw new Error(`${tool.name} requires a file_path for permission checks`);
	}

	let targetPath = resolvePath(state.cwd, filePath);
	if (state.toolPermissionContext.agentType === "memory") {
		const memoryDir = resolve(state.cwd, ".cagent", "memory");
		try {
			targetPath = await resolveContainedWritePath({
				targetPath,
				directoryPath: memoryDir,
				boundaryPath: state.cwd,
			});
		} catch {
			throw new Error(
				"Memory sub agent can only write files under .cagent/memory",
			);
		}
		if (isMemoryIndexPath(targetPath)) {
			throw new Error("MEMORY.md is managed automatically after extraction");
		}
	}

	args.file_path = targetPath;
	const policy = state.toolPermissionContext.writePolicy;
	if (!policy) {
		return;
	}
	const canonicalTarget = await resolveRealPathForWrite(targetPath);
	const memoryTarget = await resolveMemoryWriteTarget(state.cwd, targetPath);
	const policyTargets = uniquePaths(
		memoryTarget ? [canonicalTarget, memoryTarget] : [canonicalTarget],
	);

	const deniedRoots = await resolvePolicyRoots(state.cwd, policy.deny ?? []);
	const denied = policyTargets.some((candidate) =>
		deniedRoots.some((root) => isPathInside(candidate, root)),
	);
	if (denied) {
		throw new Error(`${tool.name} denied by write policy: ${filePath}`);
	}

	if (policy.allow && policy.allow.length > 0) {
		const allowedRoots = await resolvePolicyRoots(state.cwd, policy.allow);
		const allowed = policyTargets.every((candidate) =>
			allowedRoots.some((root) => isPathInside(candidate, root)),
		);
		if (!allowed) {
			throw new Error(
				`${tool.name} is outside allowed write paths: ${filePath}`,
			);
		}
	}
}

async function resolvePolicyRoots(
	cwd: string,
	entries: string[],
): Promise<string[]> {
	return Promise.all(
		entries.map((entry) => resolveRealPathForWrite(resolvePath(cwd, entry))),
	);
}

function uniquePaths(paths: string[]): string[] {
	const normalize = (path: string) =>
		process.platform === "win32" ? path.toLowerCase() : path;
	const seen = new Set<string>();
	return paths.filter((path) => {
		const key = normalize(path);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}
