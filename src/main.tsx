import { render } from "ink";
import { discoverMcpTools } from "./mcp/client";
import { createModelClientFromEnv } from "./model";
import { initializeWindowsSandbox } from "./sandbox";
import { loadSession } from "./sessionStore";
import { App } from "./ui/App";
import { createAppLifecycle } from "./ui/appLifecycle";
import { CAGENT_VERSION } from "./version";

export type CliArgs = {
	task?: string;
	resumeId?: string;
	help?: boolean;
	version?: boolean;
};

export const CLI_HELP = `Coding Agent Lab

Usage:
  cagent [task]
  cagent --resume <session-id> [task]
  cagent --help
  cagent --version

Options:
  -h, --help                 Show this help
  -V, --version              Show the installed version
      --resume <session-id>  Resume a saved workspace session

Model environment:
  DEEPSEEK_API_KEY           Enable the real DeepSeek model
  DEEPSEEK_BASE_URL          Override the API endpoint
  DEEPSEEK_MODEL             Override the model name

The release executable does not load workspace .env files. On Windows, keep
cagent.exe and cagent-windows-sandbox-runner.exe together outside the writable
workspace, then run cagent from the workspace you want to edit.`;

export function parseCliArgs(args: string[]): CliArgs {
	const taskParts: string[] = [];
	let resumeId: string | undefined;
	let help = false;
	let version = false;
	let parseOptions = true;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (parseOptions && arg === "--") {
			parseOptions = false;
		} else if (parseOptions && (arg === "--help" || arg === "-h")) {
			help = true;
		} else if (parseOptions && (arg === "--version" || arg === "-V")) {
			version = true;
		} else if (parseOptions && arg === "--resume") {
			const next = args[++index];
			if (!next) {
				throw new Error("--resume requires a session id");
			}
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

	return {
		task: taskParts.join(" ") || undefined,
		resumeId,
		...(help ? { help: true } : {}),
		...(version ? { version: true } : {}),
	};
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
	const { task, resumeId, help, version } = parseCliArgs(args);
	if (help) {
		process.stdout.write(`${CLI_HELP}\n`);
		return;
	}
	if (version) {
		process.stdout.write(`cagent ${CAGENT_VERSION}\n`);
		return;
	}

	const cwd = process.cwd();
	if (process.platform === "win32") {
		await initializeWindowsSandbox(cwd);
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
}

if (import.meta.main) {
	runCli().catch((caught) => {
		console.error(caught instanceof Error ? caught.message : String(caught));
		process.exitCode = 1;
	});
}
