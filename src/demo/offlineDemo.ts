import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { Terminal } from "../query";
import { loadSession, saveSession } from "../sessionStore";
import {
	type AgentState,
	continueState,
	createInitialState,
	resolvePlanApproval,
	resolveToolApproval,
} from "../state";
import {
	editTool,
	enterPlanModeTool,
	exitPlanModeTool,
	readTool,
	updatePlanTool,
} from "../tools";
import type { Tools } from "../tools/types";
import { toToolSpecs } from "../tools/types";
import {
	DEMO_BROKEN_EXPRESSION,
	DEMO_FILE_PATH,
	DEMO_FIXED_EXPRESSION,
	DEMO_FIXTURE_DIRECTORY,
	DEMO_FIXTURE_FILE,
} from "./demoFixture";
import {
	type PersistenceCursor,
	runPersistedQueryCycle,
} from "./persistedQuery";
import { containsSensitivePath, sanitizeFailureMessage } from "./reportSafety";
import {
	DEMO_INITIAL_ANSWER,
	DEMO_RESUME_ANSWER,
	DEMO_RESUME_TASK,
	DEMO_SESSION_ID,
	DEMO_TASK,
	type DemoModelPhase,
	ScriptedDemoModelClient,
} from "./scriptedDemoModel";

const SCENARIO = "plan-edit-session-resume";
const SCENARIO_VERSION = 1;
const TIMEOUT_MS = 30_000;

const DEMO_TOOLS: Tools = [
	readTool,
	editTool,
	enterPlanModeTool,
	updatePlanTool,
	exitPlanModeTool,
];

const EXPECTED_PHASES: DemoModelPhase[] = [
	"enter_plan",
	"plan_read",
	"update_plan",
	"exit_plan",
	"implementation_read",
	"edit",
	"verification_read",
	"complete",
	"resume_read",
	"resume_complete",
];

const EXPECTED_TOOL_SEQUENCE = [
	"EnterPlanMode",
	"Read",
	"UpdatePlan",
	"ExitPlanMode",
	"Read",
	"Edit",
	"Read",
	"Read",
];

const EXPECTED_TERMINALS: Terminal["reason"][] = [
	"plan_approval",
	"tool_approval",
	"complete",
	"complete",
];

export type OfflineDemoCheck = {
	name: string;
	ok: boolean;
};

export type OfflineDemoReport = {
	schemaVersion: 1;
	scenario: typeof SCENARIO;
	scenarioVersion: 1;
	status: "passed" | "failed";
	runtime: {
		platform: NodeJS.Platform;
		bunVersion: string;
	};
	model: string;
	workspace: "<temporary-workspace>";
	durationMs: number;
	counts: {
		queryCycles: number;
		turns: number;
		modelRequests: number;
		toolCalls: number;
		planApprovals: number;
		toolApprovals: number;
		sessionRestores: number;
	};
	requestPhases: DemoModelPhase[];
	terminalSequence: Terminal["reason"][];
	toolSequence: string[];
	changedFiles: string[];
	approvals: Array<{
		kind: "plan" | "tool";
		decision: "approve" | "allow_once";
		toolNames?: string[];
	}>;
	session: {
		id: string;
		restored: boolean;
		resumedAfterRestore: boolean;
		pendingApprovalsCleared: boolean;
	};
	safety: {
		modelNetworkUsed: false;
		shellToolAvailable: false;
		repositoryFixtureUnchanged: boolean;
		reportContainsWorkspacePath: false;
	};
	checks: OfflineDemoCheck[];
	failure?: {
		stage: string;
		message: string;
	};
};

export type OfflineDemoResult = {
	report: OfflineDemoReport;
	jsonReportPath: string;
	markdownReportPath: string;
};

export type OfflineDemoOptions = {
	reportDirectory?: string;
};

export class OfflineDemoFailure extends Error {
	readonly result: OfflineDemoResult;

	constructor(result: OfflineDemoResult) {
		super(result.report.failure?.message ?? "offline demo failed");
		this.name = "OfflineDemoFailure";
		this.result = result;
	}
}

type DemoTrace = {
	terminals: Terminal["reason"][];
	approvals: OfflineDemoReport["approvals"];
	planApprovals: number;
	toolApprovals: number;
	sessionRestores: number;
};

export async function runOfflineDemo(
	options: OfflineDemoOptions = {},
): Promise<OfflineDemoResult> {
	const startedAt = performance.now();
	const tempRoot = await mkdtemp(join(tmpdir(), "coding-agent-lab-demo-"));
	const workspace = join(tempRoot, "workspace");
	const reportDirectory = resolve(
		options.reportDirectory ?? join(tempRoot, "report"),
	);
	const model = new ScriptedDemoModelClient();
	const trace: DemoTrace = {
		terminals: [],
		approvals: [],
		planApprovals: 0,
		toolApprovals: 0,
		sessionRestores: 0,
	};
	const checks: OfflineDemoCheck[] = [];
	const cursor: PersistenceCursor = { messageCount: 0 };
	const signal = AbortSignal.timeout(TIMEOUT_MS);
	const runCycle = (cycleState: AgentState) =>
		runPersistedQueryCycle({
			state: cycleState,
			model,
			tools: DEMO_TOOLS,
			cursor,
			signal,
			onEvent(event) {
				if (event.type === "terminal") {
					trace.terminals.push(event.terminal.reason);
				}
			},
		});
	let stage = "prepare_fixture";
	let state: AgentState | undefined;
	let fixtureUnchanged = false;
	let originalFixture: string | undefined;

	try {
		const fixtureBefore = await readFile(DEMO_FIXTURE_FILE, "utf8");
		originalFixture = fixtureBefore;
		verify(
			checks,
			"fixture contains exactly one broken expression",
			countOccurrences(fixtureBefore, DEMO_BROKEN_EXPRESSION) === 1,
		);
		verify(
			checks,
			"demo tool surface excludes Shell and MCP",
			DEMO_TOOLS.every(
				(tool) => tool.name !== "Shell" && !tool.name.startsWith("mcp__"),
			),
		);
		await cp(DEMO_FIXTURE_DIRECTORY, workspace, { recursive: true });
		const expectedFile = fixtureBefore.replace(
			DEMO_BROKEN_EXPRESSION,
			DEMO_FIXED_EXPRESSION,
		);

		state = createInitialState(
			DEMO_TASK,
			workspace,
			toToolSpecs(DEMO_TOOLS),
			DEMO_SESSION_ID,
		);

		stage = "plan_approval";
		let cycle = await runCycle(state);
		state = cycle.state;
		verify(
			checks,
			"query pauses for plan approval",
			cycle.terminal.reason === "plan_approval",
		);

		stage = "restore_plan_approval";
		await saveSession(workspace, state);
		state = await loadSession(workspace, DEMO_SESSION_ID);
		trace.sessionRestores += 1;
		verify(
			checks,
			"plan-boundary restore preserves the persistence cursor",
			cursor.messageCount === state.messages.length,
		);
		verify(
			checks,
			"pending plan approval survives save and load",
			state.toolPermissionContext.pendingPlanApproval !== undefined &&
				state.toolPermissionContext.mode === "plan",
		);
		verify(
			checks,
			"restored session keeps its stable identity",
			state.sessionId === DEMO_SESSION_ID && state.cwd === workspace,
		);

		state = resolvePlanApproval(state, "approve");
		trace.planApprovals += 1;
		trace.approvals.push({ kind: "plan", decision: "approve" });

		stage = "tool_approval";
		cycle = await runCycle(state);
		state = cycle.state;
		const pendingTools =
			state.toolPermissionContext.pendingToolApproval?.requests.map(
				(request) => request.toolName,
			) ?? [];
		verify(
			checks,
			"query pauses for one Edit approval",
			cycle.terminal.reason === "tool_approval" &&
				arraysEqual(pendingTools, ["Edit"]),
		);

		state = resolveToolApproval(state, "allow_once");
		trace.toolApprovals += 1;
		trace.approvals.push({
			kind: "tool",
			decision: "allow_once",
			toolNames: pendingTools,
		});

		stage = "implementation";
		cycle = await runCycle(state);
		state = cycle.state;
		verify(
			checks,
			"approved Edit completes the first task",
			cycle.terminal.reason === "complete" &&
				state.finalAnswer === DEMO_INITIAL_ANSWER,
		);
		verify(
			checks,
			"workspace file contains the expected fix",
			(await readFile(join(workspace, DEMO_FILE_PATH), "utf8")) ===
				expectedFile,
		);

		stage = "restore_completed_session";
		await saveSession(workspace, state);
		state = await loadSession(workspace, DEMO_SESSION_ID);
		trace.sessionRestores += 1;
		verify(
			checks,
			"completed-session restore preserves the persistence cursor",
			cursor.messageCount === state.messages.length,
		);
		verify(
			checks,
			"completed transcript restores its answer and changed file",
			latestAssistantAnswer(state) === DEMO_INITIAL_ANSWER &&
				relativeChangedFiles(state, workspace).includes(DEMO_FILE_PATH),
		);

		stage = "resume_session";
		state = continueState(state, DEMO_RESUME_TASK);
		cycle = await runCycle(state);
		state = cycle.state;
		verify(
			checks,
			"restored session accepts a real follow-up query",
			cycle.terminal.reason === "complete" &&
				state.finalAnswer === DEMO_RESUME_ANSWER,
		);

		stage = "final_restore";
		await saveSession(workspace, state);
		state = await loadSession(workspace, DEMO_SESSION_ID);
		trace.sessionRestores += 1;
		verify(
			checks,
			"final restore preserves the persistence cursor",
			cursor.messageCount === state.messages.length,
		);
		verify(
			checks,
			"final restore has no pending approval",
			latestAssistantAnswer(state) === DEMO_RESUME_ANSWER &&
				state.toolPermissionContext.pendingPlanApproval === undefined &&
				state.toolPermissionContext.pendingToolApproval === undefined,
		);

		fixtureUnchanged =
			(await readFile(DEMO_FIXTURE_FILE, "utf8")) === fixtureBefore;
		verify(checks, "repository fixture remains unchanged", fixtureUnchanged);
		verify(
			checks,
			"model follows the deterministic transcript phases",
			arraysEqual(
				model.requests.map((request) => request.phase),
				EXPECTED_PHASES,
			),
		);
		verify(
			checks,
			"terminal sequence covers both approvals and resume",
			arraysEqual(trace.terminals, EXPECTED_TERMINALS),
		);
		verify(
			checks,
			"tool sequence uses only the bounded demo tools",
			arraysEqual(
				state.toolExecutions.map((execution) => execution.tool),
				EXPECTED_TOOL_SEQUENCE,
			) &&
				state.toolExecutions.every(
					(execution) => execution.status === "succeeded",
				),
		);
		verify(
			checks,
			"exactly one relative file is recorded as changed",
			arraysEqual(relativeChangedFiles(state, workspace), [DEMO_FILE_PATH]),
		);

		const report = buildReport({
			status: "passed",
			startedAt,
			model,
			state,
			workspace,
			trace,
			checks,
			fixtureUnchanged,
		});
		verify(
			checks,
			"report omits temporary and repository absolute paths",
			!containsSensitivePath(report, [
				workspace,
				tempRoot,
				process.cwd(),
				reportDirectory,
			]),
		);
		const result = await writeReports(reportDirectory, report);
		return result;
	} catch (caught) {
		if (!checks.some((check) => !check.ok)) {
			checks.push({ name: `stage completed: ${stage}`, ok: false });
		}
		fixtureUnchanged =
			originalFixture !== undefined
				? await fixtureMatches(originalFixture).catch(() => false)
				: false;
		const report = buildReport({
			status: "failed",
			startedAt,
			model,
			state,
			workspace,
			trace,
			checks,
			fixtureUnchanged,
			failure: {
				stage,
				message: sanitizeFailureMessage(caught, {
					paths: [workspace, tempRoot, process.cwd(), reportDirectory],
				}),
			},
		});
		const sensitivePaths = [
			workspace,
			tempRoot,
			process.cwd(),
			reportDirectory,
		];
		if (containsSensitivePath(report, sensitivePaths) && report.failure) {
			report.failure.message =
				"offline demo failed; path-bearing failure details were redacted";
		}
		const failureReportSafe = !containsSensitivePath(report, sensitivePaths);
		report.checks.push({
			name: "failure report omits temporary and repository absolute paths",
			ok: failureReportSafe,
		});
		if (!failureReportSafe) {
			throw new Error("offline demo report redaction failed");
		}
		const result = await writeReports(reportDirectory, report);
		throw new OfflineDemoFailure(result);
	} finally {
		await rm(workspace, { recursive: true, force: true }).catch(
			() => undefined,
		);
		if (!isPathWithin(tempRoot, reportDirectory)) {
			await rm(tempRoot, { recursive: true, force: true }).catch(
				() => undefined,
			);
		}
	}
}

function buildReport({
	status,
	startedAt,
	model,
	state,
	workspace,
	trace,
	checks,
	fixtureUnchanged,
	failure,
}: {
	status: OfflineDemoReport["status"];
	startedAt: number;
	model: ScriptedDemoModelClient;
	state: AgentState | undefined;
	workspace: string;
	trace: DemoTrace;
	checks: OfflineDemoCheck[];
	fixtureUnchanged: boolean;
	failure?: OfflineDemoReport["failure"];
}): OfflineDemoReport {
	const toolExecutions = state?.toolExecutions ?? [];
	const pendingApprovalsCleared = Boolean(
		state &&
			!state.toolPermissionContext.pendingPlanApproval &&
			!state.toolPermissionContext.pendingToolApproval,
	);
	return {
		schemaVersion: 1,
		scenario: SCENARIO,
		scenarioVersion: SCENARIO_VERSION,
		status,
		runtime: {
			platform: process.platform,
			bunVersion: process.versions.bun ?? "unknown",
		},
		model: model.name,
		workspace: "<temporary-workspace>",
		durationMs: Math.round(performance.now() - startedAt),
		counts: {
			queryCycles: trace.terminals.length,
			turns: state?.turn ?? 0,
			modelRequests: model.requests.length,
			toolCalls: toolExecutions.length,
			planApprovals: trace.planApprovals,
			toolApprovals: trace.toolApprovals,
			sessionRestores: trace.sessionRestores,
		},
		requestPhases: model.requests.map((request) => request.phase),
		terminalSequence: trace.terminals,
		toolSequence: toolExecutions.map((execution) => execution.tool),
		changedFiles: state ? relativeChangedFiles(state, workspace) : [],
		approvals: trace.approvals,
		session: {
			id: state?.sessionId ?? DEMO_SESSION_ID,
			restored: trace.sessionRestores > 0,
			resumedAfterRestore: model.requests.some(
				(request) => request.phase === "resume_complete",
			),
			pendingApprovalsCleared,
		},
		safety: {
			modelNetworkUsed: false,
			shellToolAvailable: false,
			repositoryFixtureUnchanged: fixtureUnchanged,
			reportContainsWorkspacePath: false,
		},
		checks,
		failure,
	};
}

async function writeReports(
	reportDirectory: string,
	report: OfflineDemoReport,
): Promise<OfflineDemoResult> {
	const jsonReportPath = join(reportDirectory, "offline-demo.json");
	const markdownReportPath = join(reportDirectory, "offline-demo.md");
	await mkdir(dirname(jsonReportPath), { recursive: true });
	await Promise.all([
		writeFile(jsonReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
		writeFile(markdownReportPath, formatMarkdownReport(report), "utf8"),
	]);
	return { report, jsonReportPath, markdownReportPath };
}

function formatMarkdownReport(report: OfflineDemoReport): string {
	const status = report.status === "passed" ? "PASS" : "FAIL";
	const lines = [
		"# Offline Demo Report",
		"",
		`**${status}** — \`${report.scenario}\` v${report.scenarioVersion}`,
		"",
		"> This deterministic demo uses the real query loop, approval state machine, file tools, and Session Store. It intentionally exposes no Shell tool and does not exercise the Windows native sandbox.",
		"",
		"## Summary",
		"",
		"| Field | Value |",
		"| --- | --- |",
		`| Platform | ${report.runtime.platform} |`,
		`| Bun | ${report.runtime.bunVersion} |`,
		`| Duration | ${report.durationMs} ms |`,
		`| Model requests | ${report.counts.modelRequests} |`,
		`| Tool calls | ${report.counts.toolCalls} |`,
		`| Approvals | ${report.counts.planApprovals} plan / ${report.counts.toolApprovals} tool |`,
		`| Session restores | ${report.counts.sessionRestores} |`,
		`| Changed files | ${report.changedFiles.join(", ") || "none"} |`,
		"",
		"## Trace",
		"",
		`- Terminals: ${report.terminalSequence.join(" → ") || "none"}`,
		`- Tools: ${report.toolSequence.join(" → ") || "none"}`,
		`- Model phases: ${report.requestPhases.join(" → ") || "none"}`,
		"",
		"## Checks",
		"",
		...report.checks.map(
			(check) => `- ${check.ok ? "PASS" : "FAIL"}: ${check.name}`,
		),
	];
	if (report.failure) {
		lines.push(
			"",
			"## Failure",
			"",
			`- Stage: ${report.failure.stage}`,
			`- Message: ${report.failure.message}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

function verify(
	checks: OfflineDemoCheck[],
	name: string,
	condition: boolean,
): void {
	checks.push({ name, ok: condition });
	if (!condition) {
		throw new Error(`offline demo check failed: ${name}`);
	}
}

function relativeChangedFiles(state: AgentState, workspace: string): string[] {
	return state.changedFiles.map((filePath) => {
		const relativePath = relative(workspace, resolve(workspace, filePath));
		if (
			relativePath === "" ||
			relativePath === ".." ||
			relativePath.startsWith(
				`..${process.platform === "win32" ? "\\" : "/"}`,
			) ||
			isAbsolute(relativePath)
		) {
			return "<outside-workspace>";
		}
		return relativePath.replaceAll("\\", "/");
	});
}

function latestAssistantAnswer(state: AgentState): string | undefined {
	for (let index = state.messages.length - 1; index >= 0; index--) {
		const message = state.messages[index];
		if (message?.role === "assistant" && !message.toolCalls?.length) {
			return message.content;
		}
	}
	return undefined;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function countOccurrences(value: string, needle: string): number {
	return value.split(needle).length - 1;
}

function isPathWithin(parent: string, child: string): boolean {
	const path = relative(resolve(parent), resolve(child));
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function fixtureMatches(expected: string): Promise<boolean> {
	return (await readFile(DEMO_FIXTURE_FILE, "utf8")) === expected;
}
