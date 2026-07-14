import { render } from "ink";
import { discoverMcpTools } from "./mcp/client";
import { createModelClientFromEnv } from "./model";
import { loadSession } from "./sessionStore";
import { App } from "./ui/App";

export type CliArgs = {
	task?: string;
	resumeId?: string;
};

export function parseCliArgs(args: string[]): CliArgs {
	const taskParts: string[] = [];
	let resumeId: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--resume") {
			const next = args[++index];
			if (!next) {
				throw new Error("--resume requires a session id");
			}
			resumeId = next;
		} else if (arg?.startsWith("--resume=")) {
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
	};
}

async function main(): Promise<void> {
	const cwd = process.cwd();
	const { task, resumeId } = parseCliArgs(process.argv.slice(2));
	const initialState = resumeId ? await loadSession(cwd, resumeId) : undefined;
	const model = createModelClientFromEnv();
	const mcp = await discoverMcpTools(cwd);
	for (const diagnostic of mcp.diagnostics) {
		process.stderr.write(`${diagnostic}\n`);
	}

	render(
		<App
			task={task}
			cwd={cwd}
			model={model}
			initialState={initialState}
			mcpTools={mcp.tools}
		/>,
	);
}

if (import.meta.main) {
	main().catch((caught) => {
		console.error(caught instanceof Error ? caught.message : String(caught));
		process.exitCode = 1;
	});
}
