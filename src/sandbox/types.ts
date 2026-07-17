export const WINDOWS_SANDBOX_PROTOCOL_VERSION = 1 as const;

export const WINDOWS_SANDBOX_NETWORK_NOTICE =
	"Network access is inherited from the host and is not isolated by the Windows sandbox.";

export type WindowsSandboxEnforcement = {
	filesystem: "write_restricted_acl";
	process_tree: "job_members_kill_on_close";
	network: "inherited_not_isolated";
};

export type WindowsSandboxErrorPayload = {
	stage: string;
	message: string;
	windows_error_code: number | null;
};

export type WindowsSandboxNativeRequest = {
	version: typeof WINDOWS_SANDBOX_PROTOCOL_VERSION;
	request_id: string;
	parent_pid: number;
	args: string[];
	cwd: string;
	writable_roots: string[];
	env: Record<string, string>;
	timeout_ms: number;
	max_output_bytes: number;
};

export type WindowsSandboxNativeResponse = {
	status: "ok" | "error";
	request_id: string;
	exit_code: number | null;
	stdout: string;
	stderr: string;
	timed_out: boolean;
	stdout_truncated: boolean;
	stderr_truncated: boolean;
	error: WindowsSandboxErrorPayload | null;
	enforcement: WindowsSandboxEnforcement;
};

export type WindowsSandboxRunRequest = {
	command: string;
	/** Working directory inside the fixed workspace root. */
	cwd?: string;
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
	enforcement: WindowsSandboxEnforcement;
	networkIsolated: false;
	networkNotice: typeof WINDOWS_SANDBOX_NETWORK_NOTICE;
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
