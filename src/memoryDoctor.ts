import { relative } from "node:path";
import { checkMemoryStore, type MemoryCheckReport } from "./memory";

export type MemoryCheckExitCode = 0 | 1 | 2;

export type MemoryCheckCommandOptions = {
	cwd: string;
	scan?: (cwd: string) => Promise<MemoryCheckReport>;
	writeOutput?: (content: string) => void;
	writeError?: (content: string) => void;
};

export async function runMemoryCheckCommand({
	cwd,
	scan = checkMemoryStore,
	writeOutput = (content) => process.stdout.write(content),
	writeError = (content) => process.stderr.write(content),
}: MemoryCheckCommandOptions): Promise<MemoryCheckExitCode> {
	try {
		const report = await scan(cwd);
		writeOutput(`${formatMemoryCheckReport(report)}\n`);
		if (!report.complete) {
			return 2;
		}
		return report.issues.length > 0 ? 1 : 0;
	} catch (caught) {
		writeError(`Memory check failed: ${formatCaught(caught)}\n`);
		return 2;
	}
}

export function formatMemoryCheckReport(report: MemoryCheckReport): string {
	const memoryDir = formatRelativePath(report.cwd, report.memoryDir);
	const status = !report.complete
		? "INCOMPLETE"
		: report.issues.length > 0
			? "ISSUES FOUND"
			: "OK";
	const lines = [
		`Memory check: ${status}`,
		`Directory: ${memoryDir}`,
		`Store: ${report.storeExists ? "present" : "not initialized"}`,
		`Scan: ${report.complete ? "complete" : "incomplete"}`,
		`Topics: ${report.topicCount}`,
		`Expired: ${report.expiredCount}`,
		`Issues: ${report.issues.length}`,
	];

	for (const issue of report.issues) {
		lines.push(
			"",
			`- [${issue.severity}] ${issue.code} ${issue.path}`,
			`  ${issue.message}`,
			`  Action: ${issue.action}`,
		);
	}
	return lines.join("\n");
}

function formatRelativePath(cwd: string, path: string): string {
	return relative(cwd, path).replace(/\\/g, "/") || ".";
}

function formatCaught(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}
