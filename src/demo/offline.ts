import { resolve } from "node:path";
import { OfflineDemoFailure, runOfflineDemo } from "./offlineDemo";

const HELP = `Usage: bun run demo:offline [--output-dir <path>]

Runs a deterministic coding-agent scenario in a temporary workspace.
By default, reports are retained under the operating system's temp directory.
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
		[
			"Offline demo passed.",
			`  flow: ${result.report.terminalSequence.join(" -> ")}`,
			`  tools: ${result.report.toolSequence.join(" -> ")}`,
			`  changed: ${result.report.changedFiles.join(", ")}`,
			`  session restores: ${result.report.counts.sessionRestores}`,
			`  JSON report: ${result.jsonReportPath}`,
			`  Markdown report: ${result.markdownReportPath}`,
			"",
		].join("\n"),
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
