import { render } from "ink";
import { discoverMcpTools } from "./mcp/client";
import {
	type MemoryCheckExitCode,
	runMemoryCheckCommand,
} from "./memoryDoctor";
import { createModelClientFromEnv } from "./model";
import {
	getPowerShellUpgradeWarning,
	initializeWindowsSandbox,
} from "./sandbox";
import { loadSession } from "./sessionStore";
import { App } from "./ui/App";
import { createAppLifecycle } from "./ui/appLifecycle";
import { CAGENT_VERSION } from "./version";

export type CliArgs = {
	task?: string;
	resumeId?: string;
	help?: boolean;
	version?: boolean;
	memoryCheck?: boolean;
};

export const CLI_HELP = `Coding Agent Lab

Usage:
  cagent [task]
  cagent --resume <session-id> [task]
  cagent --memory-check
  cagent --help
  cagent --version

Options:
  -h, --help                 Show this help
  -V, --version              Show the installed version
      --resume <session-id>  Resume a saved workspace session
      --memory-check         Check workspace memory without modifying files

Memory check exit codes:
  0  Scan completed with no issues
  1  Scan completed and found governance issues
  2  Scan could not complete safely

Model environment:
  DEEPSEEK_API_KEY           Enable the real DeepSeek model
  DEEPSEEK_BASE_URL          Override the API endpoint
  DEEPSEEK_MODEL             Override the model name

The release executable does not load workspace .env files. On Windows, keep
cagent.exe and cagent-windows-sandbox-runner.exe together outside the writable
workspace, then run cagent from the workspace you want to edit. PowerShell 7
is preferred; cagent warns and provides upgrade guidance when it falls back to
Windows PowerShell 5.1.`;

export function parseCliArgs(args: string[]): CliArgs {
	const taskParts: string[] = [];
	let resumeId: string | undefined;
	let help = false;
	let version = false;
	let memoryCheck = false;
	let parseOptions = true;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (parseOptions && arg === "--") {
			parseOptions = false;
		} else if (parseOptions && (arg === "--help" || arg === "-h")) {
			help = true;
		} else if (parseOptions && (arg === "--version" || arg === "-V")) {
			version = true;
		} else if (parseOptions && arg === "--memory-check") {
			memoryCheck = true;
		} else if (parseOptions && arg === "--resume") {
			const next = args[index + 1];
			if (!next || isRecognizedCliOption(next)) {
				throw new Error("--resume requires a session id");
			}
			index++;
			resumeId = next;
		} else if (parseOptions && arg?.startsWith("--resume=")) {
			resumeId = arg.slice("--resume=".length);
			if (!resumeId) {
				throw new Error("--resume requires a session id");
			}
		} else if (arg !== undefined) {
			taskParts.push(arg);
		}
	}

	const task = taskParts.join(" ") || undefined;
	if (memoryCheck && !help && !version) {
		if (resumeId) {
			throw new Error("--memory-check cannot be combined with --resume");
		}
		if (task) {
			throw new Error("--memory-check does not accept task text");
		}
	}

	return {
		task,
		resumeId,
		...(help ? { help: true } : {}),
		...(version ? { version: true } : {}),
		...(memoryCheck ? { memoryCheck: true } : {}),
	};
}

function isRecognizedCliOption(value: string): boolean {
	return (
		value === "--" ||
		value === "--help" ||
		value === "-h" ||
		value === "--version" ||
		value === "-V" ||
		value === "--memory-check" ||
		value === "--resume" ||
		value.startsWith("--resume=")
	);
}

export async function runCli(
	args = process.argv.slice(2),
): Promise<MemoryCheckExitCode> {
	const { task, resumeId, help, version, memoryCheck } = parseCliArgs(args);
	if (help) {
		process.stdout.write(`${CLI_HELP}\n`);
		return 0;
	}
	if (version) {
		process.stdout.write(`cagent ${CAGENT_VERSION}\n`);
		return 0;
	}

	const cwd = process.cwd();
	if (memoryCheck) {
		return runMemoryCheckCommand({ cwd });
	}
	if (process.platform === "win32") {
		const sandbox = await initializeWindowsSandbox(cwd);
		const preflight = await sandbox.runPowerShell({
			command: "$null = $PSVersionTable.PSVersion",
			cwd,
			executionMode: "workspace_write",
			timeoutMs: 10_000,
		});
		const warning = getPowerShellUpgradeWarning(preflight.shell);
		if (warning) {
			process.stderr.write(`${warning}\n`);
		}
	}
	const initialState = resumeId ? await loadSession(cwd, resumeId) : undefined;
	const model = createModelClientFromEnv();
	const mcp = await discoverMcpTools(cwd);
	for (const diagnostic of mcp.diagnostics) {
		process.stderr.write(`${diagnostic}\n`);
	}

	const lifecycle = createAppLifecycle();
	lifecycle.registerStopProducer(() => mcp.close());
	try {
		const app = render(
			<App
				task={task}
				cwd={cwd}
				model={model}
				initialState={initialState}
				mcpTools={mcp.tools}
				lifecycle={lifecycle}
			/>,
			{
				incrementalRendering: Boolean(process.stdout.isTTY),
				maxFps: 60,
			},
		);
		await app.waitUntilExit();
	} finally {
		await lifecycle.shutdown();
	}
	return 0;
}

if (import.meta.main) {
	runCli()
		.then((exitCode) => {
			process.exitCode = exitCode;
		})
		.catch((caught) => {
			console.error(caught instanceof Error ? caught.message : String(caught));
			process.exitCode = 1;
		});
}
