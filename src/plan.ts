import type { AgentState, PlanItemStatus, RuntimePlan } from "./state";

const PLAN_STATUS_MARKERS: Record<PlanItemStatus, string> = {
	pending: "[ ]",
	in_progress: "[~]",
	completed: "[x]",
};

export function formatPlanMarkdown(plan: RuntimePlan): string {
	const lines: string[] = [];
	const explanation = plan.explanation?.trim();
	if (explanation) {
		lines.push(explanation, "");
	}

	for (const item of plan.items) {
		lines.push(`- ${PLAN_STATUS_MARKERS[item.status]} ${item.step}`);
	}

	return lines.join("\n").trim();
}

export function getPlanModeReminder(state: AgentState): string {
	const currentPlan = formatPlanMarkdown(state.plan);
	const planSection = currentPlan
		? `\n\nCurrent runtime plan:\n${currentPlan}`
		: "";

	return `Plan mode is active. Do not modify project files, run non-readonly tools, commit changes, or otherwise change the system.

Use read-only tools to inspect the project. Maintain the plan with UpdatePlan; the plan is runtime state only and is not persisted to local files. When the plan is ready for approval, call ExitPlanMode.${planSection}`;
}
