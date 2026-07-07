import { resolve } from "node:path";
import type { AgentState } from "./state";

export const PLAN_RELATIVE_PATH = ".cagent/plan.md";

export function getPlanFilePath(cwd: string): string {
	return resolve(cwd, ".cagent", "plan.md");
}

export function isPlanFilePath(state: AgentState, filePath: string): boolean {
	return (
		normalizePath(resolve(state.cwd, filePath)) ===
		normalizePath(state.toolPermissionContext.planFilePath)
	);
}

export function getPlanModeReminder(state: AgentState): string {
	return `Plan mode is active. Do not modify project files, run non-readonly tools, commit changes, or otherwise change the system.

You may only write or edit the plan file:
${state.toolPermissionContext.planFilePath}

Use read-only tools to inspect the project. Build the plan incrementally in the plan file. When the plan is ready for approval, call ExitPlanMode.`;
}

function normalizePath(filePath: string): string {
	const normalized = resolve(filePath);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
