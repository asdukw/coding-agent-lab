import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DeepSeekModelClient } from "../model/deepseek";
import type { QueryEvent, Terminal } from "../query";
import { loadSession, saveSession } from "../sessionStore";
import {
	type AgentState,
	createInitialState,
	enterPlanMode,
	resolvePlanApproval,
	resolveToolApproval,
} from "../state";
import { editTool, exitPlanModeTool, readTool, updatePlanTool } from "../tools";
import type { Tools } from "../tools/types";
import { toToolSpecs } from "../tools/types";
import {
	DEMO_BROKEN_EXPRESSION,
	DEMO_FILE_PATH,
	DEMO_FIXED_EXPRESSION,
	DEMO_FIXTURE_DIRECTORY,
	DEMO_FIXTURE_FILE,
} from "./demoFixture";
import type { DeepSeekDotenvResult } from "./loadDeepSeekDotenv";
import {
	type PersistenceCursor,
	runPersistedQueryCycle,
} from "./persistedQuery";
import {
	containsSensitivePath,
	containsSensitiveText,
	sanitizeFailureMessage,
} from "./reportSafety";

const SCENARIO = "interactive-deepseek-plan-edit";
const SCENARIO_VERSION = 1;
const MAX_TURNS = 12;
const MAX_QUERY_CYCLES = 8;
const MAX_PLAN_DECISIONS = 3;
const MAX_TOOL_DECISIONS = 4;
const MAX_TOOL_CALLS_PER_RESPONSE = 4;
const MAX_REQUESTED_TOOL_CALLS = 16;
const QUERY_TIMEOUT_MS = 90_000;
const TASK = [
	"Work only on src/price.ts in this temporary demo workspace.",
	"Read the file, use UpdatePlan to record a concise plan, then call ExitPlanMode and wait for approval.",
	"After approval, make the smallest possible Edit: replace `1 + discountPercent / 100` with `1 - discountPercent / 100`.",
	"Read the file again to verify the change, then give a concise final answer.",
].join(" ");

const DEEPSEEK_DEMO_TOOLS: Tools = [
	readTool,
	editTool,
	updatePlanTool,
	exitPlanModeTool,
];

export type DeepSeekPlanDecision =
	| { decision: "approve" }
	| { decision: "reject"; feedback: string }
	| { decision: "abort" };

export type DeepSeekToolDecision = "allow_once" | "deny" | "abort";

export type DeepSeekToolSummary = {
	name: string;
	target?: string;
};

export type DeepSeekToolApprovalView = {
	batchTools: string[];
	requests: Array<{
		toolName: string;
		target: string;
		reason: string;
		oldText?: string;
		newText?: string;
	}>;
};

export type DeepSeekDemoProgress =
	| { type: "model_request"; model: string }
	| {
			type: "assistant_message";
			content: string;
			toolCalls: DeepSeekToolSummary[];
	  }
	| { type: "tool_result"; tool: string; ok: boolean }
	| { type: "session_restored"; sessionId: string };

export type DeepSeekDemoCallbacks = {
	onProgress?(event: DeepSeekDemoProgress): void | Promise<void>;
	decidePlan(plan: string): Promise<DeepSeekPlanDecision>;
	decideTools(view: DeepSeekToolApprovalView): Promise<DeepSeekToolDecision>;
};

export type DeepSeekDemoCheck = {
	name: string;
	ok: boolean;
};

export type DeepSeekDemoReport = {
	schemaVersion: 1;
	scenario: typeof SCENARIO;
	scenarioVersion: 1;
	status: "passed" | "failed";
	runtime: {
		platform: NodeJS.Platform;
		bunVersion: string;
	};
	model: string;
	configuration: {
		dotenvFileFound: boolean;
		dotenvAppliedKeys: string[];
	};
	workspace: "<temporary-workspace>";
	durationMs: number;
	counts: {
		queryCycles: number;
		turns: number;
		modelRequests: number;
		toolCalls: number;
		planDecisions: number;
		toolDecisions: number;
		sessionRestores: number;
	};
	terminalSequence: Terminal["reason"][];
	toolSequence: Array<{ name: string; status: string }>;
	changedFiles: string[];
	decisions: Array<{
		kind: "plan" | "tool";
		decision: "approve" | "reject" | "allow_once" | "deny";
	}>;
	session: {
		id: string;
		restored: boolean;
		restoredBeforeCleanup: boolean;
		pendingApprovalsCleared: boolean;
	};
	safety: {
		modelRequestStarted: boolean;
		shellToolAvailable: false;
		repositoryFixtureUnchanged: boolean;
		secretRecorded: false;
		reportContainsWorkspacePath: false;
	};
	checks: DeepSeekDemoCheck[];
	failure?: {
		stage: string;
		message: string;
	};
};

export type DeepSeekDemoResult = {
	report: DeepSeekDemoReport;
	diff: string;
	jsonReportPath: string;
	markdownReportPath: string;
};

export type DeepSeekDemoOptions = {
	apiKey: string;
	baseURL?: string;
	model?: string;
	signal?: AbortSignal;
	dotenv: DeepSeekDotenvResult;
	reportDirectory?: string;
	callbacks: DeepSeekDemoCallbacks;
};

export class DeepSeekDemoFailure extends Error {
	readonly result: DeepSeekDemoResult;

	constructor(result: DeepSeekDemoResult) {
		super(result.report.failure?.message ?? "DeepSeek demo failed");
		this.name = "DeepSeekDemoFailure";
		this.result = result;
	}
}

type DemoTrace = {
	terminals: Terminal["reason"][];
	decisions: DeepSeekDemoReport["decisions"];
	queryCycles: number;
	modelRequests: number;
	requestedToolCalls: number;
	planDecisions: number;
	toolDecisions: number;
	sessionRestores: number;
};

export async function runDeepSeekDemo(
	options: DeepSeekDemoOptions,
): Promise<DeepSeekDemoResult> {
	const startedAt = performance.now();
	const tempRoot = await mkdtemp(join(tmpdir(), "coding-agent-lab-deepseek-"));
	const workspace = join(tempRoot, "workspace");
	const reportDirectory = resolve(
		options.reportDirectory ?? join(tempRoot, "report"),
	);
	const model = new DeepSeekModelClient({
		apiKey: options.apiKey,
		baseURL: options.baseURL,
		model: options.model,
	});
	const trace: DemoTrace = {
		terminals: [],
		decisions: [],
		queryCycles: 0,
		modelRequests: 0,
		requestedToolCalls: 0,
		planDecisions: 0,
		toolDecisions: 0,
		sessionRestores: 0,
	};
	const checks: DeepSeekDemoCheck[] = [];
	const cursor: PersistenceCursor = { messageCount: 0 };
	const callNames = new Map<string, string>();
	let stage = "prepare_fixture";
	let state: AgentState | undefined;
	let fixtureBefore: string | undefined;
	let fixtureUnchanged = false;
	let sessionRestoredBeforeCleanup = false;
	let pendingApprovalRestoreExercised = false;
	let diff = "";

	try {
		fixtureBefore = await readFile(DEMO_FIXTURE_FILE, "utf8");
		verify(
			checks,
			"fixture contains the expected broken expression exactly once",
			countOccurrences(fixtureBefore, DEMO_BROKEN_EXPRESSION) === 1,
		);
		verify(
			checks,
			"real demo exposes only Plan, Read, and Edit tools",
			DEEPSEEK_DEMO_TOOLS.every((tool) =>
				["Read", "Edit", "UpdatePlan", "ExitPlanMode"].includes(tool.name),
			),
		);
		await cp(DEMO_FIXTURE_DIRECTORY, workspace, { recursive: true });

		const initialState = createInitialState(
			TASK,
			workspace,
			toToolSpecs(DEEPSEEK_DEMO_TOOLS),
		);
		state = enterPlanMode({
			...initialState,
			maxTurns: MAX_TURNS,
			budget: { turnsUsed: 0, maxTurns: MAX_TURNS },
		});

		let completed = false;
		for (let cycleNumber = 1; cycleNumber <= MAX_QUERY_CYCLES; cycleNumber++) {
			stage = `query_cycle_${cycleNumber}`;
			trace.queryCycles += 1;
			const cycle = await runPersistedQueryCycle({
				state,
				model,
				tools: DEEPSEEK_DEMO_TOOLS,
				cursor,
				signal: options.signal
					? AbortSignal.any([
							options.signal,
							AbortSignal.timeout(QUERY_TIMEOUT_MS),
						])
					: AbortSignal.timeout(QUERY_TIMEOUT_MS),
				onEvent: (event) =>
					handleQueryEvent({
						event,
						workspace,
						callNames,
						trace,
						callbacks: options.callbacks,
					}),
			});
			state = cycle.state;
			trace.terminals.push(cycle.terminal.reason);

			if (cycle.terminal.reason === "plan_approval") {
				stage = "plan_decision";
				if (trace.planDecisions >= MAX_PLAN_DECISIONS) {
					throw new Error("DeepSeek requested too many plan decisions");
				}
				const pending = state.toolPermissionContext.pendingPlanApproval;
				if (!pending) {
					throw new Error("plan approval terminal has no pending plan");
				}
				const decision = await options.callbacks.decidePlan(pending.plan);
				if (decision.decision === "abort") {
					throw new Error("user aborted at plan approval");
				}
				trace.planDecisions += 1;
				trace.decisions.push({
					kind: "plan",
					decision: decision.decision,
				});
				state = resolvePlanApproval(
					state,
					decision.decision,
					decision.decision === "reject" ? decision.feedback : "",
				);
				continue;
			}

			if (cycle.terminal.reason === "tool_approval") {
				stage = "tool_decision";
				if (trace.toolDecisions >= MAX_TOOL_DECISIONS) {
					throw new Error("DeepSeek requested too many tool decisions");
				}
				const pending = state.toolPermissionContext.pendingToolApproval;
				if (!pending) {
					throw new Error("tool approval terminal has no pending batch");
				}
				verify(
					checks,
					"the approval batch contains exactly the intended minimal Edit",
					isExpectedEditBatch(state, workspace),
				);
				if (!pendingApprovalRestoreExercised) {
					stage = "restore_pending_tool_approval";
					verify(
						checks,
						"Edit has not run before human approval",
						(await readFile(join(workspace, DEMO_FILE_PATH), "utf8")) ===
							fixtureBefore,
					);
					const restored = await loadSession(workspace, state.sessionId);
					trace.sessionRestores += 1;
					sessionRestoredBeforeCleanup = true;
					state = restored;
					pendingApprovalRestoreExercised = true;
					verify(
						checks,
						"restored approval requires permission revalidation",
						state.toolPermissionContext.pendingToolApproval
							?.needsRevalidation === true &&
							state.toolPermissionContext.pendingToolApproval.decision ===
								undefined &&
							isExpectedEditBatch(state, workspace),
					);
					await options.callbacks.onProgress?.({
						type: "session_restored",
						sessionId: state.sessionId,
					});
					continue;
				}
				verify(
					checks,
					"restored approval was revalidated before the human prompt",
					pending.needsRevalidation !== true,
				);
				const view = buildToolApprovalView(state, workspace);
				const decision = await options.callbacks.decideTools(view);
				if (decision === "abort") {
					throw new Error("user aborted at tool approval");
				}
				trace.toolDecisions += 1;
				trace.decisions.push({ kind: "tool", decision });
				state = resolveToolApproval(state, decision);
				continue;
			}

			if (cycle.terminal.reason === "complete") {
				if (state.toolPermissionContext.mode === "plan") {
					throw new Error("DeepSeek completed without submitting a plan");
				}
				completed = true;
				break;
			}

			throw new Error(`DeepSeek demo stopped with ${cycle.terminal.reason}`);
		}

		verify(checks, "DeepSeek reaches a normal completion", completed);
		verify(
			checks,
			"at least one plan was approved",
			trace.decisions.some(
				(decision) =>
					decision.kind === "plan" && decision.decision === "approve",
			),
		);
		verify(
			checks,
			"at least one Edit batch was allowed once",
			trace.decisions.some(
				(decision) =>
					decision.kind === "tool" && decision.decision === "allow_once",
			),
		);

		stage = "verify_change";
		const updatedFile = await readFile(join(workspace, DEMO_FILE_PATH), "utf8");
		verify(
			checks,
			"DeepSeek applies the expected minimal fix",
			updatedFile ===
				fixtureBefore.replace(DEMO_BROKEN_EXPRESSION, DEMO_FIXED_EXPRESSION),
		);
		verify(
			checks,
			"the successful execution history contains Edit",
			state.toolExecutions.some(
				(execution) =>
					execution.tool === "Edit" && execution.status === "succeeded",
			),
		);
		verify(
			checks,
			"only the intended file is recorded as changed",
			arraysEqual(relativeChangedFiles(state, workspace), [DEMO_FILE_PATH]),
		);
		diff = formatDiff(fixtureBefore, updatedFile, DEMO_FILE_PATH);

		stage = "restore_completed_session";
		await saveSession(workspace, state);
		const restored = await loadSession(workspace, state.sessionId);
		trace.sessionRestores += 1;
		sessionRestoredBeforeCleanup = true;
		verify(
			checks,
			"completed Session restores its messages and change memory",
			restored.messages.length === cursor.messageCount &&
				relativeChangedFiles(restored, workspace).includes(DEMO_FILE_PATH) &&
				Boolean(latestAssistantAnswer(restored)?.trim()),
		);
		state = restored;
		await options.callbacks.onProgress?.({
			type: "session_restored",
			sessionId: state.sessionId,
		});

		fixtureUnchanged =
			(await readFile(DEMO_FIXTURE_FILE, "utf8")) === fixtureBefore;
		verify(checks, "repository fixture remains unchanged", fixtureUnchanged);

		const report = buildReport({
			status: "passed",
			startedAt,
			modelName: model.name,
			dotenv: options.dotenv,
			state,
			workspace,
			trace,
			checks,
			fixtureUnchanged,
			sessionRestoredBeforeCleanup,
		});
		verify(
			checks,
			"report contains no API key or configured endpoint",
			!containsSensitiveText(report, sensitiveValues(options)),
		);
		verify(
			checks,
			"report contains no temporary or repository absolute path",
			!containsSensitivePath(
				report,
				sensitivePaths({
					workspace,
					tempRoot,
					reportDirectory,
				}),
			),
		);
		return await writeReports(reportDirectory, report, diff);
	} catch (caught) {
		if (!checks.some((check) => !check.ok)) {
			checks.push({ name: `stage completed: ${stage}`, ok: false });
		}
		if (state) {
			const restored = await loadSession(workspace, state.sessionId).catch(
				() => undefined,
			);
			if (restored) {
				state = restored;
				sessionRestoredBeforeCleanup = true;
			}
		}
		fixtureUnchanged = fixtureBefore
			? await readFile(DEMO_FIXTURE_FILE, "utf8")
					.then((source) => source === fixtureBefore)
					.catch(() => false)
			: false;
		const report = buildReport({
			status: "failed",
			startedAt,
			modelName: model.name,
			dotenv: options.dotenv,
			state,
			workspace,
			trace,
			checks,
			fixtureUnchanged,
			sessionRestoredBeforeCleanup,
			failure: {
				stage,
				message: sanitizeFailureMessage(caught, {
					paths: sensitivePaths({
						workspace,
						tempRoot,
						reportDirectory,
					}),
					secrets: sensitiveValues(options),
				}),
			},
		});
		if (
			containsSensitiveText(report, sensitiveValues(options)) ||
			containsSensitivePath(
				report,
				sensitivePaths({ workspace, tempRoot, reportDirectory }),
			)
		) {
			if (report.failure) {
				report.failure.message =
					"DeepSeek demo failed; sensitive failure details were redacted";
			}
		}
		if (
			containsSensitiveText(report, sensitiveValues(options)) ||
			containsSensitivePath(
				report,
				sensitivePaths({ workspace, tempRoot, reportDirectory }),
			)
		) {
			throw new Error("DeepSeek demo report redaction failed");
		}
		const result = await writeReports(reportDirectory, report, diff);
		throw new DeepSeekDemoFailure(result);
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

async function handleQueryEvent({
	event,
	workspace,
	callNames,
	trace,
	callbacks,
}: {
	event: QueryEvent;
	workspace: string;
	callNames: Map<string, string>;
	trace: DemoTrace;
	callbacks: DeepSeekDemoCallbacks;
}): Promise<void> {
	if (event.type === "request_start") {
		trace.modelRequests += 1;
		await callbacks.onProgress?.({
			type: "model_request",
			model: event.model,
		});
		return;
	}
	if (event.type !== "message") {
		return;
	}
	if (event.message.role === "assistant") {
		const requestedCalls = event.message.toolCalls ?? [];
		if (requestedCalls.length > MAX_TOOL_CALLS_PER_RESPONSE) {
			throw new Error("DeepSeek requested too many tools in one response");
		}
		trace.requestedToolCalls += requestedCalls.length;
		if (trace.requestedToolCalls > MAX_REQUESTED_TOOL_CALLS) {
			throw new Error("DeepSeek requested too many tools for this demo");
		}
		const toolCalls = requestedCalls.map((call) => {
			callNames.set(call.id, call.name);
			return summarizeToolCall(call, workspace);
		});
		await callbacks.onProgress?.({
			type: "assistant_message",
			content: redactWorkspace(event.message.content, workspace),
			toolCalls,
		});
	} else if (event.message.role === "tool") {
		await callbacks.onProgress?.({
			type: "tool_result",
			tool: event.message.toolCallId
				? (callNames.get(event.message.toolCallId) ?? "unknown")
				: "unknown",
			ok: !event.message.content.startsWith("error:"),
		});
	}
}

function buildToolApprovalView(
	state: AgentState,
	workspace: string,
): DeepSeekToolApprovalView {
	const pending = state.toolPermissionContext.pendingToolApproval;
	if (!pending) {
		throw new Error("missing pending tool approval");
	}
	return {
		batchTools: pending.calls.map((call) => call.name),
		requests: pending.requests.map((request) => ({
			toolName: request.toolName,
			target: safeRelativePath(request.args.file_path, workspace),
			reason: request.reason,
			oldText: summarizeApprovalText(request.args.old_string),
			newText: summarizeApprovalText(request.args.new_string),
		})),
	};
}

function isExpectedEditBatch(state: AgentState, workspace: string): boolean {
	const pending = state.toolPermissionContext.pendingToolApproval;
	if (
		!pending ||
		pending.calls.length === 0 ||
		pending.calls.length > MAX_TOOL_CALLS_PER_RESPONSE ||
		pending.requests.length !== 1 ||
		pending.calls.some((call) => call.name !== "Read" && call.name !== "Edit")
	) {
		return false;
	}

	const editCalls = pending.calls.filter((call) => call.name === "Edit");
	if (editCalls.length !== 1) {
		return false;
	}
	const editCall = editCalls[0];
	const request = pending.requests[0];
	if (!editCall || !request) {
		return false;
	}
	const callArgs = parseToolCallArguments(editCall.arguments);
	if (!callArgs) {
		return false;
	}

	return (
		request.callId === editCall.id &&
		request.toolName === "Edit" &&
		safeRelativePath(request.args.file_path, workspace) === DEMO_FILE_PATH &&
		request.args.old_string === DEMO_BROKEN_EXPRESSION &&
		request.args.new_string === DEMO_FIXED_EXPRESSION &&
		(request.args.replace_all === undefined ||
			request.args.replace_all === false) &&
		safeRelativePath(callArgs.file_path, workspace) === DEMO_FILE_PATH &&
		callArgs.old_string === DEMO_BROKEN_EXPRESSION &&
		callArgs.new_string === DEMO_FIXED_EXPRESSION &&
		(callArgs.replace_all === undefined || callArgs.replace_all === false)
	);
}

function summarizeApprovalText(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	return value.length <= 160 ? value : `${value.slice(0, 157)}...`;
}

function parseToolCallArguments(
	value: string,
): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function summarizeToolCall(
	call: { name: string; arguments: string },
	workspace: string,
): DeepSeekToolSummary {
	let args: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(call.arguments) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			args = parsed as Record<string, unknown>;
		}
	} catch {
		return { name: call.name };
	}
	const rawPath = args.file_path;
	return {
		name: call.name,
		target:
			typeof rawPath === "string"
				? safeRelativePath(rawPath, workspace)
				: undefined,
	};
}

function safeRelativePath(value: unknown, workspace: string): string {
	if (typeof value !== "string" || !value.trim()) {
		return "<unknown>";
	}
	const path = relative(workspace, resolve(workspace, value));
	if (
		path === "" ||
		path === ".." ||
		path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
		isAbsolute(path)
	) {
		return "<outside-workspace>";
	}
	return path.replaceAll("\\", "/");
}

function relativeChangedFiles(state: AgentState, workspace: string): string[] {
	return state.changedFiles.map((path) => safeRelativePath(path, workspace));
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

function buildReport({
	status,
	startedAt,
	modelName,
	dotenv,
	state,
	workspace,
	trace,
	checks,
	fixtureUnchanged,
	sessionRestoredBeforeCleanup,
	failure,
}: {
	status: DeepSeekDemoReport["status"];
	startedAt: number;
	modelName: string;
	dotenv: DeepSeekDotenvResult;
	state: AgentState | undefined;
	workspace: string;
	trace: DemoTrace;
	checks: DeepSeekDemoCheck[];
	fixtureUnchanged: boolean;
	sessionRestoredBeforeCleanup: boolean;
	failure?: DeepSeekDemoReport["failure"];
}): DeepSeekDemoReport {
	return {
		schemaVersion: 1,
		scenario: SCENARIO,
		scenarioVersion: SCENARIO_VERSION,
		status,
		runtime: {
			platform: process.platform,
			bunVersion: process.versions.bun ?? "unknown",
		},
		model: safeModelName(modelName),
		configuration: {
			dotenvFileFound: dotenv.fileFound,
			dotenvAppliedKeys: dotenv.appliedKeys.slice(),
		},
		workspace: "<temporary-workspace>",
		durationMs: Math.round(performance.now() - startedAt),
		counts: {
			queryCycles: trace.queryCycles,
			turns: state?.turn ?? 0,
			modelRequests: trace.modelRequests,
			toolCalls: state?.toolExecutions.length ?? 0,
			planDecisions: trace.planDecisions,
			toolDecisions: trace.toolDecisions,
			sessionRestores: trace.sessionRestores,
		},
		terminalSequence: trace.terminals.slice(),
		toolSequence:
			state?.toolExecutions.map((execution) => ({
				name: execution.tool,
				status: execution.status,
			})) ?? [],
		changedFiles: state ? relativeChangedFiles(state, workspace) : [],
		decisions: trace.decisions.slice(),
		session: {
			id: state?.sessionId ?? "<not-started>",
			restored: trace.sessionRestores > 0,
			restoredBeforeCleanup: sessionRestoredBeforeCleanup,
			pendingApprovalsCleared: Boolean(
				state &&
					!state.toolPermissionContext.pendingPlanApproval &&
					!state.toolPermissionContext.pendingToolApproval,
			),
		},
		safety: {
			modelRequestStarted: trace.modelRequests > 0,
			shellToolAvailable: false,
			repositoryFixtureUnchanged: fixtureUnchanged,
			secretRecorded: false,
			reportContainsWorkspacePath: false,
		},
		checks,
		failure,
	};
}

async function writeReports(
	reportDirectory: string,
	report: DeepSeekDemoReport,
	diff: string,
): Promise<DeepSeekDemoResult> {
	const jsonReportPath = join(reportDirectory, "deepseek-demo.json");
	const markdownReportPath = join(reportDirectory, "deepseek-demo.md");
	await mkdir(dirname(jsonReportPath), { recursive: true });
	await Promise.all([
		writeFile(jsonReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
		writeFile(markdownReportPath, formatMarkdownReport(report), "utf8"),
	]);
	return { report, diff, jsonReportPath, markdownReportPath };
}

function formatMarkdownReport(report: DeepSeekDemoReport): string {
	const status = report.status === "passed" ? "PASS" : "FAIL";
	const lines = [
		"# Interactive DeepSeek Demo Report",
		"",
		`**${status}** — \`${report.scenario}\` v${report.scenarioVersion}`,
		"",
		"> This report intentionally omits prompts, model output, tool arguments, tool output, API configuration values, and absolute paths.",
		"",
		"## Summary",
		"",
		"| Field | Value |",
		"| --- | --- |",
		`| Model | ${report.model} |`,
		`| Platform | ${report.runtime.platform} |`,
		`| Duration | ${report.durationMs} ms |`,
		`| Model requests | ${report.counts.modelRequests} |`,
		`| Tool calls | ${report.counts.toolCalls} |`,
		`| Decisions | ${report.counts.planDecisions} plan / ${report.counts.toolDecisions} tool |`,
		`| Changed files | ${report.changedFiles.join(", ") || "none"} |`,
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

function formatDiff(before: string, after: string, filePath: string): string {
	if (before === after) {
		return "No file changes.";
	}
	return [
		`--- a/${filePath}`,
		`+++ b/${filePath}`,
		"@@",
		...before.split("\n").map((line) => `-${line}`),
		...after.split("\n").map((line) => `+${line}`),
	].join("\n");
}

function redactWorkspace(value: string, workspace: string): string {
	return value
		.split(workspace)
		.join("<temporary-workspace>")
		.split(workspace.replaceAll("\\", "/"))
		.join("<temporary-workspace>");
}

function sensitivePaths({
	workspace,
	tempRoot,
	reportDirectory,
}: {
	workspace: string;
	tempRoot: string;
	reportDirectory: string;
}): string[] {
	return [
		workspace,
		tempRoot,
		reportDirectory,
		process.cwd(),
		DEMO_FIXTURE_DIRECTORY,
	];
}

function sensitiveValues(options: DeepSeekDemoOptions): string[] {
	return [options.apiKey, options.baseURL ?? ""].filter(Boolean);
}

function safeModelName(value: string): string {
	return /^[A-Za-z0-9._:/-]{1,120}$/.test(value) ? value : "<configured-model>";
}

function isPathWithin(parent: string, child: string): boolean {
	const path = relative(resolve(parent), resolve(child));
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function countOccurrences(value: string, needle: string): number {
	if (!needle) {
		return 0;
	}
	return value.split(needle).length - 1;
}

function verify(
	checks: DeepSeekDemoCheck[],
	name: string,
	condition: boolean,
): void {
	checks.push({ name, ok: condition });
	if (!condition) {
		throw new Error(`DeepSeek demo check failed: ${name}`);
	}
}
