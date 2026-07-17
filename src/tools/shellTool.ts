import { z } from "zod";
import {
	getWindowsSandbox,
	getWindowsSandboxWorkspaceRoot,
	WINDOWS_SANDBOX_NETWORK_NOTICE,
} from "../sandbox";
import {
	fileResourceAccesses,
	opaqueToolAccess,
	type ResourceAccess,
} from "./resourceLock";
import type { Tool, ToolContext } from "./types";

export const SHELL_TOOL_NAME = "Shell";
const SANDBOX_RUNTIME_RESOURCE = "windows-sandbox-process";

const shellInputSchema = z.object({
	command: z
		.string()
		.min(1)
		.max(10_000)
		.describe("PowerShell command to execute inside the Windows sandbox"),
	timeout_ms: z
		.number()
		.int()
		.min(100)
		.max(600_000)
		.optional()
		.describe("Command timeout in milliseconds; defaults to 120000"),
});

type ShellInput = z.infer<typeof shellInputSchema>;

export type ShellOutput = {
	stdout: string;
	stderr: string;
	exit_code: number;
	timed_out: boolean;
	stdout_truncated: boolean;
	stderr_truncated: boolean;
	enforcement: {
		filesystem: "write_restricted_acl";
		process_tree: "job_members_kill_on_close";
		network: "inherited_not_isolated";
	};
	network_isolated: false;
	network_notice: typeof WINDOWS_SANDBOX_NETWORK_NOTICE;
};

export const shellTool: Tool<ShellInput, ShellOutput> = {
	name: SHELL_TOOL_NAME,
	description:
		"Execute one non-interactive PowerShell command in the native Windows filesystem/process sandbox. Writes are restricted to the fixed workspace. Members assigned to the Windows Job are terminated on timeout or cancellation; brokered processes outside that Job are not covered. Network access is inherited rather than isolated.",
	inputSchema: shellInputSchema,
	async getResourceAccesses(_input, context) {
		const cwd = requireContext(context).getState().cwd;
		const workspaceRoot = getWindowsSandboxWorkspaceRoot(cwd);
		const workspaceAccesses = await fileResourceAccesses(
			workspaceRoot,
			"write",
			"subtree",
		);
		const sandboxAccess: ResourceAccess = {
			namespace: "runtime",
			key: SANDBOX_RUNTIME_RESOURCE,
			mode: "write",
			scope: "exact",
		};
		return [...workspaceAccesses, sandboxAccess, opaqueToolAccess()];
	},
	async call({ command, timeout_ms }, context) {
		const toolContext = requireContext(context);
		const state = toolContext.getState();
		const sandbox = await getWindowsSandbox(state.cwd);
		const result = await sandbox.runPowerShell({
			command,
			cwd: state.cwd,
			timeoutMs: timeout_ms,
			signal: toolContext.signal,
		});
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exit_code: result.exitCode,
			timed_out: result.timedOut,
			stdout_truncated: result.stdoutTruncated,
			stderr_truncated: result.stderrTruncated,
			enforcement: result.enforcement,
			network_isolated: false,
			network_notice: WINDOWS_SANDBOX_NETWORK_NOTICE,
		};
	},
};

function requireContext(context: ToolContext | undefined): ToolContext {
	if (!context) {
		throw new Error("Shell tool requires a runtime context.");
	}
	return context;
}
