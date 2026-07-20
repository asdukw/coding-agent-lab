import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
	DeepSeekDemoFailure,
	type DeepSeekDemoProgress,
	type DeepSeekPlanDecision,
	type DeepSeekToolApprovalView,
	type DeepSeekToolDecision,
	runDeepSeekDemo,
} from "./deepseekDemo";
import { loadDeepSeekDotenv } from "./loadDeepSeekDotenv";

const HELP = `Usage: bun run demo:deepseek [--output-dir <path>]

Runs a real DeepSeek coding-agent scenario in a temporary workspace.
The repository root .env file is loaded explicitly for DEEPSEEK_* values only.
Plan and Edit actions require interactive approval; there is no auto-approve mode.
`;

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.help) {
		process.stdout.write(HELP);
		return;
	}

	const dotenv = await loadDeepSeekDotenv();
	const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
	if (!apiKey) {
		throw new Error(
			"DEEPSEEK_API_KEY is required. Set it in the parent process or copy .env.example to .env and fill in the key.",
		);
	}
	if (apiKey.length < 8) {
		throw new Error("DEEPSEEK_API_KEY appears too short");
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(
			"demo:deepseek requires an interactive terminal for explicit approvals",
		);
	}

	process.stdout.write(
		[
			"Interactive DeepSeek demo",
			"  workspace: temporary copy (the repository fixture is read-only)",
			"  tools: Read, Edit, UpdatePlan, ExitPlanMode",
			`  dotenv: ${dotenv.fileFound ? "repository .env found" : "not found; using parent environment"}`,
			`  dotenv values applied: ${dotenv.appliedKeys.length}`,
			"  note: this uses the real API and may incur charges",
			"",
		].join("\n"),
	);

	const readline = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	const abortController = new AbortController();
	const handleInterrupt = () => {
		if (!abortController.signal.aborted) {
			abortController.abort(new Error("user interrupted the DeepSeek demo"));
		}
		readline.close();
	};
	readline.on("SIGINT", handleInterrupt);
	process.on("SIGINT", handleInterrupt);
	try {
		const result = await runDeepSeekDemo({
			apiKey,
			baseURL: optionalEnv("DEEPSEEK_BASE_URL"),
			model: optionalEnv("DEEPSEEK_MODEL"),
			signal: abortController.signal,
			dotenv,
			reportDirectory: parsed.reportDirectory,
			callbacks: {
				onProgress: displayProgress,
				decidePlan: (plan) => decidePlan(readline, plan),
				decideTools: (view) => decideTools(readline, view),
			},
		});

		process.stdout.write(
			[
				"",
				"[diff]",
				sanitizeTerminalText(result.diff),
				"",
				"DeepSeek demo passed.",
				`  flow: ${result.report.terminalSequence.join(" -> ")}`,
				`  changed: ${result.report.changedFiles.join(", ")}`,
				`  JSON report: ${result.jsonReportPath}`,
				`  Markdown report: ${result.markdownReportPath}`,
				"",
			].join("\n"),
		);
	} finally {
		readline.off("SIGINT", handleInterrupt);
		process.off("SIGINT", handleInterrupt);
		readline.close();
	}
}

async function displayProgress(event: DeepSeekDemoProgress): Promise<void> {
	if (event.type === "model_request") {
		process.stdout.write(
			`\n[model request] ${sanitizeTerminalText(event.model)}\n`,
		);
	} else if (event.type === "assistant_message") {
		if (event.content.trim()) {
			process.stdout.write(
				`[assistant]\n${sanitizeTerminalText(event.content.trim())}\n`,
			);
		}
		if (event.toolCalls.length > 0) {
			process.stdout.write("[requested tools]\n");
			for (const tool of event.toolCalls) {
				const target = tool.target ? ` (${tool.target})` : "";
				process.stdout.write(
					`  - ${sanitizeTerminalText(tool.name)}${sanitizeTerminalText(target)}\n`,
				);
			}
		}
	} else if (event.type === "tool_result") {
		process.stdout.write(
			`[tool result] ${sanitizeTerminalText(event.tool)}: ${event.ok ? "succeeded" : "failed"}\n`,
		);
	} else {
		process.stdout.write(
			`[session restored] ${sanitizeTerminalText(event.sessionId)}\n`,
		);
	}
}

async function decidePlan(
	readline: ReturnType<typeof createInterface>,
	plan: string,
): Promise<DeepSeekPlanDecision> {
	process.stdout.write(`\n[plan approval]\n${sanitizeTerminalText(plan)}\n`);
	for (;;) {
		const answer = await ask(readline, "Type approve, reject, or abort: ");
		if (answer === "approve") {
			return { decision: "approve" };
		}
		if (answer === "reject") {
			const feedback = await ask(readline, "Plan feedback: ", false);
			return { decision: "reject", feedback };
		}
		if (answer === "abort") {
			return { decision: "abort" };
		}
		process.stdout.write("Expected exactly: approve, reject, or abort.\n");
	}
}

async function decideTools(
	readline: ReturnType<typeof createInterface>,
	view: DeepSeekToolApprovalView,
): Promise<DeepSeekToolDecision> {
	process.stdout.write("\n[tool batch paused]\n");
	process.stdout.write(
		`  batch: ${sanitizeTerminalText(view.batchTools.join(", "))}\n`,
	);
	process.stdout.write("  side effects requiring approval:\n");
	for (const request of view.requests) {
		process.stdout.write(
			`    - ${sanitizeTerminalText(request.toolName)} (${sanitizeTerminalText(request.target)}): ${sanitizeTerminalText(request.reason)}\n`,
		);
		if (request.oldText !== undefined) {
			process.stdout.write(
				`      old: ${sanitizeTerminalText(request.oldText)}\n`,
			);
		}
		if (request.newText !== undefined) {
			process.stdout.write(
				`      new: ${sanitizeTerminalText(request.newText)}\n`,
			);
		}
	}
	for (;;) {
		const answer = await ask(readline, "Type allow, deny, or abort: ");
		if (answer === "allow") {
			return "allow_once";
		}
		if (answer === "deny") {
			return "deny";
		}
		if (answer === "abort") {
			return "abort";
		}
		process.stdout.write("Expected exactly: allow, deny, or abort.\n");
	}
}

async function ask(
	readline: ReturnType<typeof createInterface>,
	prompt: string,
	normalize = true,
): Promise<string> {
	try {
		const answer = await readline.question(prompt);
		return normalize ? answer.trim().toLowerCase() : answer.trim();
	} catch {
		return "abort";
	}
}

function parseArgs(args: string[]): {
	help: boolean;
	reportDirectory?: string;
} {
	let reportDirectory: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			return { help: true };
		}
		if (arg === "--output-dir") {
			const value = args[index + 1];
			if (!value) {
				throw new Error("--output-dir requires a path");
			}
			reportDirectory = resolve(value);
			index += 1;
			continue;
		}
		throw new Error(`unknown argument: ${arg}`);
	}
	return { help: false, reportDirectory };
}

function optionalEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

function sanitizeTerminalText(value: string): string {
	let result = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (
			character === "\n" ||
			character === "\r" ||
			character === "\t" ||
			(code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))
		) {
			result += character;
		} else {
			result += "�";
		}
	}
	return result;
}

main().catch((caught) => {
	if (caught instanceof DeepSeekDemoFailure) {
		process.stderr.write(
			`${JSON.stringify({
				status: "failed",
				failure: caught.result.report.failure,
				jsonReportPath: caught.result.jsonReportPath,
				markdownReportPath: caught.result.markdownReportPath,
			})}\n`,
		);
	} else {
		process.stderr.write(
			`${JSON.stringify({
				status: "failed",
				failure: {
					stage: "cli",
					message: caught instanceof Error ? caught.message : String(caught),
				},
			})}\n`,
		);
	}
	process.exitCode = 1;
});
