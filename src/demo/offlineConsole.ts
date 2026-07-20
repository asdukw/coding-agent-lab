import { DEMO_BROKEN_EXPRESSION, DEMO_FIXED_EXPRESSION } from "./demoFixture";
import type { OfflineDemoReport, OfflineDemoResult } from "./offlineDemo";

const DIVIDER = "-".repeat(72);
const LABEL_WIDTH = 12;
const UNICODE_FORMAT_CONTROL = /\p{Cf}/u;

type OutputStream = {
	isTTY?: boolean;
};

type Palette = {
	bold(value: string): string;
	dim(value: string): string;
	green(value: string): string;
	red(value: string): string;
	cyan(value: string): string;
};

export function shouldUseConsoleColor(stream: OutputStream): boolean {
	if (process.env.NO_COLOR !== undefined || process.env.TERM === "dumb") {
		return false;
	}
	return stream.isTTY === true;
}

export function formatOfflineDemoSuccess(
	result: OfflineDemoResult,
	useColor: boolean,
): string {
	return formatOfflineDemoResult(result, useColor);
}

export function formatOfflineDemoFailure(
	result: OfflineDemoResult,
	useColor: boolean,
): string {
	return formatOfflineDemoResult(result, useColor);
}

export function formatOfflineCliFailure(
	caught: unknown,
	useColor: boolean,
): string {
	const palette = createPalette(useColor);
	const message = sanitizeTerminalLine(
		caught instanceof Error ? caught.message : String(caught),
	);
	return [
		DIVIDER,
		`${palette.red("[FAIL]")} ${palette.bold("OFFLINE DEMO CLI")}`,
		DIVIDER,
		formatRow("Failure", message),
		DIVIDER,
		"",
	].join("\n");
}

function formatOfflineDemoResult(
	result: OfflineDemoResult,
	useColor: boolean,
): string {
	const { report } = result;
	const palette = createPalette(useColor);
	const passed = report.status === "passed";
	const status = passed ? palette.green("[PASS]") : palette.red("[FAIL]");
	const checksPassed = report.checks.filter((check) => check.ok).length;
	const approvalSummary = report.approvals.map(formatApproval).join(" | ");
	const safetySummary = [
		`model API=${yesNo(report.safety.modelNetworkUsed, "used", "not used")}`,
		`shell=${yesNo(report.safety.shellToolAvailable, "available", "not exposed")}`,
		`repo fixture=${yesNo(
			report.safety.repositoryFixtureUnchanged,
			"unchanged",
			"changed",
		)}`,
	].join(" | ");
	const changedFiles = report.changedFiles.length
		? report.changedFiles.map(sanitizeTerminalLine).join(", ")
		: "none";

	const lines = [
		DIVIDER,
		`${status} ${palette.bold("OFFLINE / DETERMINISTIC AGENT DEMO")}`,
		palette.dim(
			"Scripted model; real Agent Loop, approvals, file tools, and Session Store.",
		),
		palette.dim(
			"This does not call a model API or exercise the native Windows sandbox.",
		),
		DIVIDER,
		formatRow("Scenario", `${report.scenario} v${report.scenarioVersion}`),
		formatRow(
			"Runtime",
			`${report.runtime.platform} | Bun ${report.runtime.bunVersion} | ${report.durationMs} ms`,
		),
		formatRow(
			"Metrics",
			[
				`requests=${report.counts.modelRequests}`,
				`tools=${report.counts.toolCalls}`,
				`turns=${report.counts.turns}`,
				`cycles=${report.counts.queryCycles}`,
			].join(" | "),
		),
		...formatSequenceRows("Flow", report.terminalSequence.map(formatTerminal)),
		...formatSequenceRows("Model", report.requestPhases.map(formatModelPhase)),
		...formatSequenceRows(
			"Tools",
			report.toolSequence.map(sanitizeTerminalLine),
		),
		formatRow("Approvals", approvalSummary || "none"),
		formatRow(
			"Session",
			[
				`restored=${report.counts.sessionRestores}x`,
				`resumed=${yesNo(report.session.resumedAfterRestore)}`,
				`approvals cleared=${yesNo(report.session.pendingApprovalsCleared)}`,
			].join(" | "),
		),
		formatRow("Checks", `${checksPassed}/${report.checks.length} passed`),
		formatRow("Safety", safetySummary),
		formatRow("Changed", `${changedFiles} (temporary workspace only)`),
	];

	if (passed) {
		lines.push(
			formatRow("Fix", `${DEMO_BROKEN_EXPRESSION} -> ${DEMO_FIXED_EXPRESSION}`),
		);
	} else {
		const failedChecks = report.checks.filter((check) => !check.ok);
		lines.push(DIVIDER, palette.red("Failed checks"));
		for (const check of failedChecks) {
			lines.push(`  - ${sanitizeTerminalLine(check.name)}`);
		}
		if (report.failure) {
			lines.push(
				formatRow("Stage", report.failure.stage),
				formatRow("Failure", report.failure.message),
			);
		}
	}

	lines.push(
		DIVIDER,
		palette.cyan("Reports"),
		formatRow("JSON", result.jsonReportPath),
		formatRow("Markdown", result.markdownReportPath),
		DIVIDER,
		"",
	);
	return lines.join("\n");
}

function formatRow(label: string, value: unknown): string {
	return `${label.padEnd(LABEL_WIDTH)}${sanitizeTerminalLine(value)}`;
}

function formatSequenceRows(
	label: string,
	values: readonly string[],
): string[] {
	if (values.length === 0) {
		return [formatRow(label, "none")];
	}
	const rows: string[] = [];
	let current = "";
	for (const rawValue of values) {
		const value = sanitizeTerminalLine(rawValue);
		const candidate = current ? `${current} -> ${value}` : value;
		if (current && candidate.length > 78 - LABEL_WIDTH) {
			rows.push(formatRow(rows.length === 0 ? label : "", current));
			current = value;
		} else {
			current = candidate;
		}
	}
	rows.push(formatRow(rows.length === 0 ? label : "", current));
	return rows;
}

function formatApproval(
	approval: OfflineDemoReport["approvals"][number],
): string {
	if (approval.kind === "plan") {
		return `plan=${approval.decision}`;
	}
	const tools = approval.toolNames?.join("+") || "tool";
	return `${tools}=${approval.decision}`;
}

function formatTerminal(
	reason: OfflineDemoReport["terminalSequence"][number],
	index: number,
	sequence: readonly OfflineDemoReport["terminalSequence"][number][],
): string {
	if (reason === "plan_approval") {
		return "plan gate";
	}
	if (reason === "tool_approval") {
		return "tool gate";
	}
	if (reason === "complete") {
		const completeIndex = sequence
			.slice(0, index + 1)
			.filter((value) => value === "complete").length;
		return completeIndex === 1 ? "task complete" : "resume complete";
	}
	return reason.replaceAll("_", " ");
}

function formatModelPhase(
	phase: OfflineDemoReport["requestPhases"][number],
): string {
	const labels: Record<OfflineDemoReport["requestPhases"][number], string> = {
		enter_plan: "enter plan",
		plan_read: "plan read",
		update_plan: "update plan",
		exit_plan: "submit plan",
		implementation_read: "implementation read",
		edit: "edit",
		verification_read: "verification read",
		complete: "task answer",
		resume_read: "resume read",
		resume_complete: "resume answer",
	};
	return labels[phase];
}

function yesNo(value: boolean, yes = "yes", no = "no"): string {
	return value ? yes : no;
}

function sanitizeTerminalLine(value: unknown): string {
	let result = "";
	for (const character of String(value)) {
		const code = character.codePointAt(0) ?? 0;
		if (
			character === "\n" ||
			character === "\r" ||
			character === "\t" ||
			code === 0x2028 ||
			code === 0x2029
		) {
			result += " ";
		} else if (
			code >= 0x20 &&
			code !== 0x7f &&
			!(code >= 0x80 && code <= 0x9f) &&
			!UNICODE_FORMAT_CONTROL.test(character)
		) {
			result += character;
		} else {
			result += "?";
		}
	}
	return result.replaceAll(/\s+/g, " ").trim();
}

function createPalette(enabled: boolean): Palette {
	const paint = (code: number, value: string) =>
		enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
	return {
		bold: (value) => paint(1, value),
		dim: (value) => paint(2, value),
		green: (value) => paint(32, value),
		red: (value) => paint(31, value),
		cyan: (value) => paint(36, value),
	};
}
