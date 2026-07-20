import { z } from "zod";
import {
	getWindowsSandbox,
	getWindowsSandboxWorkspaceRoot,
	WINDOWS_FULL_ACCESS_NOTICE,
	WINDOWS_SANDBOX_NETWORK_NOTICE,
} from "../sandbox";
import { hasDangerFullAccess } from "../state";
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
		.describe("PowerShell command to execute under the active permission mode"),
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
		filesystem: "write_restricted_acl" | "unrestricted";
		process_tree: "job_members_kill_on_close";
		network: "inherited_not_isolated" | "inherited_unrestricted";
	};
	network_isolated: false;
	network_notice: string;
};

export const shellTool: Tool<ShellInput, ShellOutput> = {
	name: SHELL_TOOL_NAME,
	description:
		"Execute one non-interactive PowerShell command. The active permission mode selects either workspace-restricted filesystem access or explicit host-user filesystem/environment/network authority. In both modes, members assigned to the Windows Job are terminated on timeout or cancellation; brokered processes outside that Job are not covered.",
	inputSchema: shellInputSchema,
	async getResourceAccesses(_input, context) {
		const state = requireContext(context).getState();
		if (hasDangerFullAccess(state)) {
			const workspaceAccesses = await fileResourceAccesses(
				state.cwd,
				"write",
				"subtree",
			);
			return [
				...workspaceAccesses,
				{
					namespace: "runtime",
					key: SANDBOX_RUNTIME_RESOURCE,
					mode: "write",
					scope: "exact",
				} satisfies ResourceAccess,
				opaqueToolAccess(),
			];
		}
		const cwd = state.cwd;
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
		const dangerFullAccess = hasDangerFullAccess(state);
		const sandbox = await getWindowsSandbox(state.cwd);
		const result = await sandbox.runPowerShell({
			command,
			cwd: state.cwd,
			executionMode: dangerFullAccess
				? "danger_full_access"
				: "workspace_write",
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
			network_notice: dangerFullAccess
				? WINDOWS_FULL_ACCESS_NOTICE
				: WINDOWS_SANDBOX_NETWORK_NOTICE,
		};
	},
};

function requireContext(context: ToolContext | undefined): ToolContext {
	if (!context) {
		throw new Error("Shell tool requires a runtime context.");
	}
	return context;
}
