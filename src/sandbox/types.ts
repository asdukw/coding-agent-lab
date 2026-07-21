export const WINDOWS_SANDBOX_PROTOCOL_VERSION = 3 as const;

export const WINDOWS_SANDBOX_NETWORK_NOTICE =
	"Network access is inherited from the host and is not isolated by the Windows sandbox.";
export const WINDOWS_FULL_ACCESS_NOTICE =
	"Full access runs PowerShell with the host user's filesystem, environment, and network authority; the Windows Job still bounds the process tree.";
export const WINDOWS_POWERSHELL_UPGRADE_WARNING = [
	"WARNING: PowerShell 7 (pwsh.exe) was not found in a trusted installation.",
	"cagent is using the Windows PowerShell 5.1 compatibility fallback; modern PowerShell syntax may fail and cause avoidable command retries.",
	"Install or update PowerShell 7 with:",
	"  winget install --id Microsoft.PowerShell --source winget",
	"  winget upgrade --id Microsoft.PowerShell --source winget",
	"Then restart cagent so the trusted PowerShell 7 installation is detected.",
].join("\n");

export type WindowsSandboxExecutionMode =
	| "workspace_write"
	| "danger_full_access";

export type WindowsSandboxEnforcement =
	| {
			filesystem: "write_restricted_acl";
			process_tree: "job_members_kill_on_close";
			network: "inherited_not_isolated";
	  }
	| {
			filesystem: "unrestricted";
			process_tree: "job_members_kill_on_close";
			network: "inherited_unrestricted";
	  };

export type WindowsSandboxErrorPayload = {
	stage: string;
	message: string;
	windows_error_code: number | null;
};

export type WindowsSandboxShell =
	| {
			engine: "pwsh";
			version: "7";
			fallback: false;
	  }
	| {
			engine: "windows_powershell";
			version: "5.1";
			fallback: true;
	  };

export function getPowerShellUpgradeWarning(
	shell: WindowsSandboxShell,
): string | undefined {
	return shell.fallback ? WINDOWS_POWERSHELL_UPGRADE_WARNING : undefined;
}

export type WindowsSandboxNativeRequest = {
	version: typeof WINDOWS_SANDBOX_PROTOCOL_VERSION;
	request_id: string;
	parent_pid: number;
	execution_mode: WindowsSandboxExecutionMode;
	args: string[];
	cwd: string;
	writable_roots: string[];
	env: Record<string, string>;
	timeout_ms: number;
	max_output_bytes: number;
};

type WindowsSandboxNativeResponseBase = {
	request_id: string;
	stdout: string;
	stderr: string;
	timed_out: boolean;
	stdout_truncated: boolean;
	stderr_truncated: boolean;
	enforcement: WindowsSandboxEnforcement;
};

export type WindowsSandboxNativeResponse = WindowsSandboxNativeResponseBase &
	(
		| {
				status: "ok";
				exit_code: number;
				error: null;
				shell: WindowsSandboxShell;
		  }
		| {
				status: "error";
				exit_code: null;
				error: WindowsSandboxErrorPayload;
				shell: null;
		  }
	);

export type WindowsSandboxRunRequest = {
	command: string;
	/** Working directory inside the fixed workspace root. */
	cwd?: string;
	/** Select the bounded workspace sandbox or explicit host-user authority. */
	executionMode?: WindowsSandboxExecutionMode;
	timeoutMs?: number;
	signal?: AbortSignal;
};

export type WindowsSandboxRunResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	shell: WindowsSandboxShell;
	enforcement: WindowsSandboxEnforcement;
	networkIsolated: false;
	networkNotice:
		| typeof WINDOWS_SANDBOX_NETWORK_NOTICE
		| typeof WINDOWS_FULL_ACCESS_NOTICE;
};

export type WindowsSandboxOptions = {
	/**
	 * Explicit path to the trusted native runner. Relative paths resolve from
	 * the host cwd, and the final file must be outside the writable workspace.
	 * The runner is never resolved through PATH.
	 */
	helperPath?: string;
	defaultTimeoutMs?: number;
	maxOutputBytes?: number;
};

export interface WindowsSandboxExecutor {
	readonly workspaceRoot: string;
	runPowerShell(
		request: WindowsSandboxRunRequest,
	): Promise<WindowsSandboxRunResult>;
}
