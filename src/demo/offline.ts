import { resolve } from "node:path";
import {
	formatOfflineCliFailure,
	formatOfflineDemoFailure,
	formatOfflineDemoSuccess,
	shouldUseConsoleColor,
} from "./offlineConsole";
import { OfflineDemoFailure, runOfflineDemo } from "./offlineDemo";

const HELP = `Usage: bun run demo:offline [--output-dir <path>]

Runs a deterministic coding-agent scenario in a temporary workspace.
By default, reports are retained under the operating system's temp directory.
The terminal summary explains the flow, tools, approvals, Session, and safety checks.
`;

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.help) {
		process.stdout.write(HELP);
		return;
	}

	const result = await runOfflineDemo({
		reportDirectory: parsed.reportDirectory,
	});
	process.stdout.write(
		formatOfflineDemoSuccess(result, shouldUseConsoleColor(process.stdout)),
	);
}

function parseArgs(args: string[]): {
	help: boolean;
	reportDirectory?: string;
} {
	let reportDirectory = process.env.CAGENT_DEMO_REPORT_DIR;
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
			reportDirectory = value;
			index += 1;
			continue;
		}
		throw new Error(`unknown argument: ${arg}`);
	}
	return {
		help: false,
		reportDirectory: reportDirectory ? resolve(reportDirectory) : undefined,
	};
}

main().catch((caught) => {
	if (caught instanceof OfflineDemoFailure) {
		process.stderr.write(
			formatOfflineDemoFailure(
				caught.result,
				shouldUseConsoleColor(process.stderr),
			),
		);
	} else {
		process.stderr.write(
			formatOfflineCliFailure(caught, shouldUseConsoleColor(process.stderr)),
		);
	}
	process.exitCode = 1;
});
