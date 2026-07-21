import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	WINDOWS_FULL_ACCESS_NOTICE,
	WINDOWS_SANDBOX_NETWORK_NOTICE,
	WINDOWS_SANDBOX_PROTOCOL_VERSION,
	type WindowsSandboxEnforcement,
	type WindowsSandboxErrorPayload,
	type WindowsSandboxExecutionMode,
	type WindowsSandboxExecutor,
	type WindowsSandboxNativeRequest,
	type WindowsSandboxNativeResponse,
	type WindowsSandboxOptions,
	type WindowsSandboxRunRequest,
	type WindowsSandboxRunResult,
	type WindowsSandboxShell,
} from "./types";

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MIN_MAX_OUTPUT_BYTES = 1024;
const MAX_MAX_OUTPUT_BYTES = 1024 * 1024;
const WATCHDOG_GRACE_MS = 5_000;
const HELPER_CLOSE_DEADLINE_MS = 5_000;
const HELPER_STDERR_LIMIT_BYTES = 64 * 1024;
const PROTOCOL_OVERHEAD_BYTES = 64 * 1024;
// EncodedCommand expands UTF-16LE input by roughly 8/3. Keep the complete
// CreateProcess command line comfortably below Windows' 32,767-char limit.
const MAX_COMMAND_CHARS = 10_000;

const REQUEST_KEYS = new Set([
	"version",
	"request_id",
	"parent_pid",
	"execution_mode",
	"args",
	"cwd",
	"writable_roots",
	"env",
	"timeout_ms",
	"max_output_bytes",
]);
const RESPONSE_KEYS = new Set([
	"status",
	"request_id",
	"exit_code",
	"stdout",
	"stderr",
	"timed_out",
	"stdout_truncated",
	"stderr_truncated",
	"error",
	"enforcement",
	"shell",
]);
const LEGACY_V2_RESPONSE_KEYS = new Set(
	[...RESPONSE_KEYS].filter((key) => key !== "shell"),
);
const ERROR_KEYS = new Set(["stage", "message", "windows_error_code"]);
const ENFORCEMENT_KEYS = new Set(["filesystem", "process_tree", "network"]);
const SHELL_KEYS = new Set(["engine", "version", "fallback"]);
const LEGACY_V2_PROTOCOL_ERROR_MESSAGE = `unsupported protocol version ${WINDOWS_SANDBOX_PROTOCOL_VERSION}; expected 2`;

const ALLOWED_ENVIRONMENT_KEYS = [
	"ComSpec",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"Path",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"ProgramData",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"ProgramW6432",
	"SystemDrive",
	"SystemRoot",
	"TEMP",
	"TMP",
	"WINDIR",
] as const;

/**
 * A native sandbox failure. This is deliberately distinct from a command
 * returning a non-zero exit code: the latter is a valid sandbox result.
 */
export class WindowsSandboxError extends Error {
	readonly stage: string;
	readonly windowsErrorCode?: number;
	readonly enforcement?: WindowsSandboxEnforcement;

	constructor(
		message: string,
		options: {
			stage: string;
			windowsErrorCode?: number;
			enforcement?: WindowsSandboxEnforcement;
			cause?: unknown;
		},
	) {
		super(message, { cause: options.cause });
		this.name = "WindowsSandboxError";
		this.stage = options.stage;
		this.windowsErrorCode = options.windowsErrorCode;
		this.enforcement = options.enforcement;
	}
}

class AsyncSerialQueue {
	private active = false;
	private readonly pending: Array<{
		resolve(release: () => void): void;
		reject(error: Error): void;
		signal?: AbortSignal;
		onAbort?: () => void;
	}> = [];

	async run<T>(
		signal: AbortSignal | undefined,
		task: () => Promise<T>,
	): Promise<T> {
		const release = await this.acquire(signal);
		try {
			throwIfAborted(signal);
			return await task();
		} finally {
			release();
		}
	}

	private acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) {
			return Promise.reject(createAbortError(signal));
		}
		if (!this.active) {
			this.active = true;
			return Promise.resolve(this.createRelease());
		}

		return new Promise<() => void>((resolveLease, rejectLease) => {
			const waiter: (typeof this.pending)[number] = {
				resolve: resolveLease,
				reject: rejectLease,
				signal,
			};
			if (signal) {
				waiter.onAbort = () => {
					const index = this.pending.indexOf(waiter);
					if (index >= 0) {
						this.pending.splice(index, 1);
						rejectLease(createAbortError(signal));
					}
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.pending.push(waiter);
		});
	}

	private createRelease(): () => void {
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			for (;;) {
				const next = this.pending.shift();
				if (!next) {
					this.active = false;
					return;
				}
				if (next.signal && next.onAbort) {
					next.signal.removeEventListener("abort", next.onAbort);
				}
				if (next.signal?.aborted) {
					next.reject(createAbortError(next.signal));
					continue;
				}
				next.resolve(this.createRelease());
				return;
			}
		};
	}
}

// Deliberately shared by every WindowsSandbox instance in this process.
const sandboxProcessQueue = new AsyncSerialQueue();
let sandboxPoison:
	| {
			reason: string;
			cause?: unknown;
	  }
	| undefined;

export class WindowsSandbox implements WindowsSandboxExecutor {
	readonly workspaceRoot: string;
	readonly helperPath: string;
	private readonly defaultTimeoutMs: number;
	private readonly maxOutputBytes: number;
	private readonly environment: Record<string, string>;

	private constructor(options: {
		workspaceRoot: string;
		helperPath: string;
		defaultTimeoutMs: number;
		maxOutputBytes: number;
		environment: Record<string, string>;
	}) {
		this.workspaceRoot = options.workspaceRoot;
		this.helperPath = options.helperPath;
		this.defaultTimeoutMs = options.defaultTimeoutMs;
		this.maxOutputBytes = options.maxOutputBytes;
		this.environment = options.environment;
	}

	static async create(
		workspaceRoot: string,
		options: WindowsSandboxOptions = {},
	): Promise<WindowsSandbox> {
		if (process.platform !== "win32") {
			throw new WindowsSandboxError(
				"The native Windows sandbox is unavailable on this platform.",
				{ stage: "platform" },
			);
		}

		const canonicalRoot = await requireDirectory(
			workspaceRoot,
			"workspace root",
		);
		const helperPath = await resolveHelperPath(
			canonicalRoot,
			options.helperPath,
		);
		const defaultTimeoutMs = boundedInteger(
			options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
			MIN_TIMEOUT_MS,
			MAX_TIMEOUT_MS,
			"default timeout",
		);
		const maxOutputBytes = boundedInteger(
			options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
			MIN_MAX_OUTPUT_BYTES,
			MAX_MAX_OUTPUT_BYTES,
			"maximum output bytes",
		);
		const environment = sanitizedEnvironment();

		return new WindowsSandbox({
			workspaceRoot: canonicalRoot,
			helperPath,
			defaultTimeoutMs,
			maxOutputBytes,
			environment,
		});
	}

	async runPowerShell(
		request: WindowsSandboxRunRequest,
	): Promise<WindowsSandboxRunResult> {
		assertSandboxHealthy();
		const command = request.command;
		if (!command.trim()) {
			throw new WindowsSandboxError("PowerShell command cannot be empty.", {
				stage: "validate_request",
			});
		}
		if (command.length > MAX_COMMAND_CHARS) {
			throw new WindowsSandboxError(
				`PowerShell command exceeds ${MAX_COMMAND_CHARS} characters.`,
				{ stage: "validate_request" },
			);
		}
		const timeoutMs = boundedInteger(
			request.timeoutMs ?? this.defaultTimeoutMs,
			MIN_TIMEOUT_MS,
			MAX_TIMEOUT_MS,
			"command timeout",
		);
		const commandCwd = await requireDirectory(
			request.cwd ?? this.workspaceRoot,
			"command working directory",
		);
		if (!isPathInside(commandCwd, this.workspaceRoot)) {
			throw new WindowsSandboxError(
				`Command working directory is outside the fixed workspace root: ${commandCwd}`,
				{ stage: "validate_cwd" },
			);
		}
		const executionMode = request.executionMode ?? "workspace_write";

		return sandboxProcessQueue.run(request.signal, async () => {
			assertSandboxHealthy();
			const requestId = randomUUID();
			const wrappedCommand = wrapPowerShellCommand(command);
			const nativeRequest: WindowsSandboxNativeRequest = {
				version: WINDOWS_SANDBOX_PROTOCOL_VERSION,
				request_id: requestId,
				parent_pid: process.pid,
				execution_mode: executionMode,
				args: [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-EncodedCommand",
					Buffer.from(wrappedCommand, "utf16le").toString("base64"),
				],
				cwd: commandCwd,
				writable_roots: [this.workspaceRoot],
				env:
					executionMode === "danger_full_access"
						? hostEnvironment()
						: { ...this.environment },
				timeout_ms: timeoutMs,
				max_output_bytes: this.maxOutputBytes,
			};
			assertNativeRequest(nativeRequest);

			const response = await executeNativeHelper({
				helperPath: this.helperPath,
				workspaceRoot: this.workspaceRoot,
				environment: this.environment,
				request: nativeRequest,
				signal: request.signal,
				watchdogMs: timeoutMs + WATCHDOG_GRACE_MS,
				maxProtocolBytes: this.maxOutputBytes * 12 + PROTOCOL_OVERHEAD_BYTES,
			});

			return {
				exitCode: response.exit_code,
				stdout: response.stdout,
				stderr: response.stderr,
				timedOut: response.timed_out,
				stdoutTruncated: response.stdout_truncated,
				stderrTruncated: response.stderr_truncated,
				shell: response.shell,
				enforcement: response.enforcement,
				networkIsolated: false,
				networkNotice:
					executionMode === "danger_full_access"
						? WINDOWS_FULL_ACCESS_NOTICE
						: WINDOWS_SANDBOX_NETWORK_NOTICE,
			};
		});
	}
}

export async function createWindowsSandbox(
	workspaceRoot: string,
	options: WindowsSandboxOptions = {},
): Promise<WindowsSandbox> {
	return WindowsSandbox.create(workspaceRoot, options);
}

async function executeNativeHelper(options: {
	helperPath: string;
	workspaceRoot: string;
	environment: Record<string, string>;
	request: WindowsSandboxNativeRequest;
	signal?: AbortSignal;
	watchdogMs: number;
	maxProtocolBytes: number;
}): Promise<Extract<WindowsSandboxNativeResponse, { status: "ok" }>> {
	throwIfAborted(options.signal);

	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawn(options.helperPath, [], {
			cwd: options.workspaceRoot,
			env: options.environment,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			shell: false,
		});
	} catch (caught) {
		throw new WindowsSandboxError(
			"Failed to start the native sandbox helper.",
			{
				stage: "spawn_helper",
				cause: caught,
			},
		);
	}

	type TerminationReason =
		| "abort"
		| "watchdog"
		| "protocol_overflow"
		| "spawn_error"
		| "failure_cleanup";
	type CloseDeadline = { kind: "close_deadline" };

	let termination: TerminationReason | undefined;
	let spawnError: unknown;
	let killFailure: unknown;
	let killAttempted = false;
	let closeObserved = false;
	let closeDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let resolveCloseDeadline: ((result: CloseDeadline) => void) | undefined;
	const closeDeadlinePromise = new Promise<CloseDeadline>((resolveDeadline) => {
		resolveCloseDeadline = resolveDeadline;
	});
	const startCloseDeadline = () => {
		if (closeDeadlineTimer) {
			return;
		}
		closeDeadlineTimer = setTimeout(() => {
			resolveCloseDeadline?.({ kind: "close_deadline" });
		}, HELPER_CLOSE_DEADLINE_MS);
	};
	const closePromise = waitForChild(child).then((result) => {
		closeObserved = true;
		return result;
	});
	const terminate = (reason: TerminationReason) => {
		termination ??= reason;
		if (!isChildExitConfirmed(child, closeObserved) && !killAttempted) {
			killAttempted = true;
			killFailure = requestChildKill(child);
		}
		startCloseDeadline();
	};
	const onChildError = (caught: unknown) => {
		spawnError ??= caught;
		terminate("spawn_error");
	};
	child.on("error", onChildError);
	const stdoutPromise = collectBounded(
		child.stdout,
		options.maxProtocolBytes,
		() => terminate("protocol_overflow"),
	);
	const stderrPromise = collectBounded(child.stderr, HELPER_STDERR_LIMIT_BYTES);
	const onAbort = () => terminate("abort");
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const watchdog = setTimeout(() => terminate("watchdog"), options.watchdogMs);
	watchdog.unref?.();

	try {
		// Handle EPIPE as a process/protocol failure below instead of an unhandled
		// stream error when a malformed or unavailable helper exits early.
		child.stdin.on("error", () => undefined);
		child.stdin.end(JSON.stringify(options.request));

		const completionPromise = Promise.all([
			closePromise,
			stdoutPromise,
			stderrPromise,
		]).then((value) => ({ kind: "completed" as const, value }));
		const completion = await Promise.race([
			completionPromise,
			closeDeadlinePromise,
		]);
		if (completion.kind === "close_deadline") {
			throw new WindowsSandboxError(
				`Native sandbox helper did not settle within ${HELPER_CLOSE_DEADLINE_MS} ms after termination was requested${formatKillFailure(killFailure)}.`,
				{ stage: "helper_close_deadline", cause: spawnError },
			);
		}

		const [{ code, signal }, stdout, helperStderr] = completion.value;
		if (termination === "abort") {
			throw createAbortError(options.signal);
		}
		if (termination === "watchdog") {
			throw new WindowsSandboxError(
				`Native sandbox helper exceeded its ${options.watchdogMs} ms watchdog.`,
				{ stage: "helper_watchdog" },
			);
		}
		if (termination === "protocol_overflow" || stdout.truncated) {
			throw new WindowsSandboxError(
				"Native sandbox helper exceeded the protocol output limit.",
				{ stage: "protocol_output" },
			);
		}
		if (spawnError !== undefined) {
			throw new WindowsSandboxError(
				`Native sandbox helper failed before completing${formatHelperExit(code, signal, helperStderr.text)}.`,
				{ stage: "spawn_helper", cause: spawnError },
			);
		}
		if (!stdout.text.trim()) {
			throw new WindowsSandboxError(
				`Native sandbox helper returned no response${formatHelperExit(code, signal, helperStderr.text)}.`,
				{ stage: "protocol_output" },
			);
		}

		const response = parseNativeResponse(
			stdout.text,
			options.request.request_id,
			options.request.execution_mode,
		);
		if (response.status === "error") {
			const error = response.error;
			throw new WindowsSandboxError(
				`${error.stage}: ${error.message}${formatHelperStderr(helperStderr.text)}`,
				{
					stage: error.stage,
					windowsErrorCode: error.windows_error_code ?? undefined,
					enforcement: response.enforcement,
				},
			);
		}
		if (code !== 0) {
			throw new WindowsSandboxError(
				`Native sandbox helper exited with code ${String(code)} after an ok response${formatHelperStderr(helperStderr.text)}.`,
				{ stage: "protocol_exit", enforcement: response.enforcement },
			);
		}
		return response;
	} catch (caught) {
		if (!isChildExitConfirmed(child, closeObserved)) {
			terminate(termination ?? "failure_cleanup");
			const cleanup = await Promise.race([
				closePromise.then(() => "closed" as const),
				closeDeadlinePromise.then(() => "deadline" as const),
			]);
			if (
				cleanup === "deadline" &&
				!isChildExitConfirmed(child, closeObserved)
			) {
				destroyChildIo(child);
				throw poisonSandbox(
					`The native sandbox helper could not be confirmed stopped within ${HELPER_CLOSE_DEADLINE_MS} ms${formatKillFailure(killFailure)}.`,
					caught,
				);
			}
		}
		throw caught;
	} finally {
		clearTimeout(watchdog);
		if (closeDeadlineTimer) {
			clearTimeout(closeDeadlineTimer);
		}
		options.signal?.removeEventListener("abort", onAbort);
		if (isChildExitConfirmed(child, closeObserved)) {
			child.removeListener("error", onChildError);
		}
	}
}

/** @internal Exported from this implementation module for protocol fixture tests. */
export function parseNativeResponse(
	text: string,
	expectedRequestId: string,
	expectedExecutionMode: WindowsSandboxExecutionMode,
): WindowsSandboxNativeResponse {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (caught) {
		throw new WindowsSandboxError(
			"Native sandbox helper returned invalid JSON.",
			{ stage: "parse_response", cause: caught },
		);
	}
	const response = requireRecord(value, "sandbox response");
	if (isLegacyV2ProtocolMismatch(response, expectedRequestId)) {
		throw new WindowsSandboxError(
			`The installed Windows sandbox helper only supports protocol v2, but this client requires protocol v${WINDOWS_SANDBOX_PROTOCOL_VERSION}. Run \`bun run build:sandbox\` to rebuild and install the current helper.`,
			{ stage: "helper_protocol_mismatch" },
		);
	}
	assertExactKeys(response, RESPONSE_KEYS, "sandbox response");
	const status = requireEnum(response.status, ["ok", "error"], "status");
	const requestId = requireString(response.request_id, "request_id");
	if (requestId !== expectedRequestId) {
		throw new WindowsSandboxError(
			"Native sandbox helper returned a mismatched request id.",
			{ stage: "validate_response" },
		);
	}
	const enforcement = parseEnforcement(
		response.enforcement,
		expectedExecutionMode,
	);
	const error =
		response.error === null ? null : parseErrorPayload(response.error);
	const shell = response.shell === null ? null : parseShell(response.shell);
	const exitCode =
		response.exit_code === null
			? null
			: requireInteger(response.exit_code, "exit_code");

	const common = {
		request_id: requestId,
		stdout: requireString(response.stdout, "stdout"),
		stderr: requireString(response.stderr, "stderr"),
		timed_out: requireBoolean(response.timed_out, "timed_out"),
		stdout_truncated: requireBoolean(
			response.stdout_truncated,
			"stdout_truncated",
		),
		stderr_truncated: requireBoolean(
			response.stderr_truncated,
			"stderr_truncated",
		),
		enforcement,
	};
	if (status === "ok") {
		if (exitCode === null || error !== null || shell === null) {
			throw new WindowsSandboxError(
				"An ok sandbox response must contain an exit code and shell metadata, and no error.",
				{ stage: "validate_response", enforcement },
			);
		}
		return {
			...common,
			status,
			exit_code: exitCode,
			error: null,
			shell,
		};
	}
	if (exitCode !== null || error === null || shell !== null) {
		throw new WindowsSandboxError(
			"An error sandbox response must contain an error, no exit code, and no shell metadata.",
			{ stage: "validate_response", enforcement },
		);
	}
	return {
		...common,
		status,
		exit_code: null,
		error,
		shell: null,
	};
}

function isLegacyV2ProtocolMismatch(
	response: Record<string, unknown>,
	expectedRequestId: string,
): boolean {
	if (!hasExactKeys(response, LEGACY_V2_RESPONSE_KEYS)) {
		return false;
	}
	if (
		response.status !== "error" ||
		response.request_id !== expectedRequestId ||
		response.exit_code !== null ||
		response.stdout !== "" ||
		response.stderr !== "" ||
		response.timed_out !== false ||
		response.stdout_truncated !== false ||
		response.stderr_truncated !== false
	) {
		return false;
	}

	const error = response.error;
	if (
		typeof error !== "object" ||
		error === null ||
		Array.isArray(error) ||
		!hasExactKeys(error, ERROR_KEYS)
	) {
		return false;
	}
	const errorRecord = error as Record<string, unknown>;
	if (
		errorRecord.stage !== "validate_request" ||
		errorRecord.message !== LEGACY_V2_PROTOCOL_ERROR_MESSAGE ||
		errorRecord.windows_error_code !== null
	) {
		return false;
	}

	const enforcement = response.enforcement;
	return (
		typeof enforcement === "object" &&
		enforcement !== null &&
		!Array.isArray(enforcement) &&
		hasExactKeys(enforcement, ENFORCEMENT_KEYS) &&
		(enforcement as Record<string, unknown>).filesystem ===
			"write_restricted_acl" &&
		(enforcement as Record<string, unknown>).process_tree ===
			"job_members_kill_on_close" &&
		(enforcement as Record<string, unknown>).network ===
			"inherited_not_isolated"
	);
}

function parseEnforcement(
	value: unknown,
	expectedExecutionMode: WindowsSandboxExecutionMode,
): WindowsSandboxEnforcement {
	const record = requireRecord(value, "enforcement");
	assertExactKeys(record, ENFORCEMENT_KEYS, "enforcement");
	const expected: WindowsSandboxEnforcement =
		expectedExecutionMode === "danger_full_access"
			? {
					filesystem: "unrestricted",
					process_tree: "job_members_kill_on_close",
					network: "inherited_unrestricted",
				}
			: {
					filesystem: "write_restricted_acl",
					process_tree: "job_members_kill_on_close",
					network: "inherited_not_isolated",
				};
	if (
		record.filesystem !== expected.filesystem ||
		record.process_tree !== expected.process_tree ||
		record.network !== expected.network
	) {
		throw new WindowsSandboxError(
			`enforcement does not match execution mode ${expectedExecutionMode}.`,
			{ stage: "validate_response" },
		);
	}
	return expected;
}

function parseErrorPayload(value: unknown): WindowsSandboxErrorPayload {
	const record = requireRecord(value, "sandbox error");
	assertExactKeys(record, ERROR_KEYS, "sandbox error");
	const windowsErrorCode =
		record.windows_error_code === null
			? null
			: requireNonNegativeInteger(
					record.windows_error_code,
					"windows_error_code",
				);
	return {
		stage: requireString(record.stage, "error.stage"),
		message: requireString(record.message, "error.message"),
		windows_error_code: windowsErrorCode,
	};
}

function parseShell(value: unknown): WindowsSandboxShell {
	const record = requireRecord(value, "shell");
	assertExactKeys(record, SHELL_KEYS, "shell");
	const engine = requireEnum(
		record.engine,
		["pwsh", "windows_powershell"],
		"shell.engine",
	);
	const version = requireEnum(record.version, ["7", "5.1"], "shell.version");
	const fallback = requireBoolean(record.fallback, "shell.fallback");

	if (engine === "pwsh" && version === "7" && !fallback) {
		return { engine, version, fallback };
	}
	if (engine === "windows_powershell" && version === "5.1" && fallback) {
		return { engine, version, fallback };
	}
	throw new WindowsSandboxError(
		"shell metadata must be either pwsh 7 without fallback or Windows PowerShell 5.1 with fallback.",
		{ stage: "validate_response" },
	);
}

async function resolveHelperPath(
	workspaceRoot: string,
	configuredPath: string | undefined,
): Promise<string> {
	const explicitPath = configuredPath;
	const candidates = explicitPath
		? [resolveConfiguredPath(explicitPath)]
		: defaultHelperCandidates();
	for (const candidate of candidates) {
		try {
			const canonical = await requireFile(candidate, "native sandbox helper");
			if (isPathInside(canonical, workspaceRoot)) {
				throw new WindowsSandboxError(
					"The native sandbox helper must be installed outside the writable workspace root.",
					{ stage: "validate_helper" },
				);
			}
			return canonical;
		} catch (caught) {
			if (
				explicitPath ||
				!(
					caught instanceof WindowsSandboxError &&
					caught.stage === "validate_path"
				)
			) {
				throw caught;
			}
		}
	}
	throw new WindowsSandboxError(
		`Native sandbox helper was not found. Keep the release runner beside cagent.exe, or run "bun run build:sandbox" from the source repository. Checked: ${candidates.join(", ")}`,
		{ stage: "helper_unavailable" },
	);
}

function defaultHelperCandidates(): string[] {
	return [
		resolve(dirname(process.execPath), "cagent-windows-sandbox-runner.exe"),
		resolve(
			trustedWindowsUserProfile(),
			"AppData",
			"Local",
			"cagent",
			"bin",
			"cagent-windows-sandbox-runner.exe",
		),
	];
}

function trustedWindowsUserProfile(): string {
	const userPathNames = new Set([
		"home",
		"homedrive",
		"homepath",
		"userprofile",
	]);
	const removed: Array<[string, string]> = [];
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && userPathNames.has(key.toLowerCase())) {
			removed.push([key, value]);
			delete process.env[key];
		}
	}
	try {
		const profile = userInfo().homedir;
		if (!profile || !isAbsolute(profile)) {
			throw new WindowsSandboxError(
				"Windows did not return an absolute user profile path.",
				{ stage: "helper_unavailable" },
			);
		}
		return resolve(profile);
	} finally {
		for (const [key, value] of removed) {
			process.env[key] = value;
		}
	}
}

function sanitizedEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const key of ALLOWED_ENVIRONMENT_KEYS) {
		const value = readEnvironmentValue(key);
		if (value && !value.includes("\0")) {
			environment[key] = value;
		}
	}
	environment.CAGENT_SANDBOX = "windows-v3";
	return environment;
}

function hostEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.includes("\0") && !value.includes("\0")) {
			environment[key] = value;
		}
	}
	return environment;
}

function wrapPowerShellCommand(command: string): string {
	return [
		"[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
		"$OutputEncoding = [Console]::OutputEncoding",
		"$global:LASTEXITCODE = $null",
		"& {",
		command,
		"}",
		"$__cagent_command_succeeded = $?",
		"$__cagent_native_exit_code = $global:LASTEXITCODE",
		"if ($__cagent_command_succeeded) { exit 0 }",
		"if ($null -ne $__cagent_native_exit_code -and [int]$__cagent_native_exit_code -ne 0) { exit ([int]$__cagent_native_exit_code) }",
		"exit 1",
	].join("\r\n");
}

function readEnvironmentValue(name: string): string | undefined {
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(process.env)) {
		if (key.toLowerCase() === expected && value) {
			return value;
		}
	}
	return undefined;
}

async function requireDirectory(path: string, label: string): Promise<string> {
	const canonical = await canonicalExistingPath(path, label);
	const metadata = await stat(canonical);
	if (!metadata.isDirectory()) {
		throw new WindowsSandboxError(`${label} is not a directory: ${canonical}`, {
			stage: "validate_path",
		});
	}
	return canonical;
}

async function requireFile(path: string, label: string): Promise<string> {
	const canonical = await canonicalExistingPath(path, label);
	const metadata = await stat(canonical);
	if (!metadata.isFile()) {
		throw new WindowsSandboxError(`${label} is not a file: ${canonical}`, {
			stage: "validate_path",
		});
	}
	return canonical;
}

async function canonicalExistingPath(
	path: string,
	label: string,
): Promise<string> {
	const resolved = resolve(path);
	try {
		return await realpath(resolved);
	} catch (caught) {
		throw new WindowsSandboxError(`${label} is unavailable: ${resolved}`, {
			stage: "validate_path",
			cause: caught,
		});
	}
}

function resolveConfiguredPath(path: string): string {
	if (!path.trim()) {
		throw new WindowsSandboxError("Configured helper path cannot be empty.", {
			stage: "validate_path",
		});
	}
	return isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
}

function isPathInside(path: string, parent: string): boolean {
	const normalizedPath = normalizePath(path);
	const normalizedParent = normalizePath(parent);
	const rel = relative(normalizedParent, normalizedPath);
	return (
		rel === "" ||
		(!!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
	);
}

function normalizePath(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

function boundedInteger(
	value: number,
	minimum: number,
	maximum: number,
	label: string,
): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new WindowsSandboxError(
			`${label} must be an integer between ${minimum} and ${maximum}.`,
			{ stage: "validate_request" },
		);
	}
	return value;
}

function waitForChild(
	child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolveWait) => {
		child.once("close", (code, signal) => resolveWait({ code, signal }));
	});
}

function isChildExitConfirmed(
	child: ChildProcessWithoutNullStreams,
	closeObserved: boolean,
): boolean {
	return closeObserved || child.exitCode !== null || child.signalCode !== null;
}

function requestChildKill(
	child: ChildProcessWithoutNullStreams,
): Error | undefined {
	try {
		const accepted = child.kill("SIGKILL");
		return accepted
			? undefined
			: new Error("Node.js reported that the helper kill request was rejected");
	} catch (caught) {
		return caught instanceof Error
			? caught
			: new Error(`The helper kill request threw: ${String(caught)}`);
	}
}

function destroyChildIo(child: ChildProcessWithoutNullStreams): void {
	for (const stream of [child.stdin, child.stdout, child.stderr]) {
		try {
			stream.destroy();
		} catch {
			// The process has already failed to stop; best-effort pipe cleanup only.
		}
	}
}

function formatKillFailure(failure: unknown): string {
	if (failure === undefined) {
		return "";
	}
	const detail = failure instanceof Error ? failure.message : String(failure);
	return `; kill request failed: ${detail}`;
}

function poisonSandbox(reason: string, cause?: unknown): WindowsSandboxError {
	sandboxPoison ??= { reason, cause };
	return sandboxPoisonError();
}

function assertSandboxHealthy(): void {
	if (sandboxPoison) {
		throw sandboxPoisonError();
	}
}

function sandboxPoisonError(): WindowsSandboxError {
	const poison = sandboxPoison;
	return new WindowsSandboxError(
		poison
			? `The Windows sandbox is poisoned and cannot start another helper until this process is restarted. ${poison.reason}`
			: "The Windows sandbox is poisoned and cannot start another helper until this process is restarted.",
		{ stage: "sandbox_poisoned", cause: poison?.cause },
	);
}

function collectBounded(
	stream: NodeJS.ReadableStream,
	limitBytes: number,
	onOverflow?: () => void,
): Promise<{ text: string; truncated: boolean }> {
	return new Promise((resolveRead, rejectRead) => {
		const chunks: Buffer[] = [];
		let captured = 0;
		let truncated = false;
		stream.on("data", (value: Buffer | string) => {
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
			const capturedBeforeChunk = captured;
			if (captured < limitBytes) {
				const remaining = limitBytes - captured;
				const kept = chunk.subarray(0, remaining);
				chunks.push(kept);
				captured += kept.length;
			}
			if (chunk.length > Math.max(0, limitBytes - capturedBeforeChunk)) {
				if (!truncated) {
					truncated = true;
					onOverflow?.();
				}
			}
		});
		stream.once("error", rejectRead);
		stream.once("end", () =>
			resolveRead({ text: Buffer.concat(chunks).toString("utf8"), truncated }),
		);
	});
}

function assertNativeRequest(
	value: unknown,
): asserts value is WindowsSandboxNativeRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throwInvalidNativeRequest("sandbox request must be an object");
	}
	const request = value as Record<string, unknown>;
	assertExactKeys(request, REQUEST_KEYS, "sandbox request", "validate_request");
	if (request.version !== WINDOWS_SANDBOX_PROTOCOL_VERSION) {
		throwInvalidNativeRequest(
			`sandbox request version must be ${WINDOWS_SANDBOX_PROTOCOL_VERSION}`,
		);
	}
	if (typeof request.request_id !== "string" || !request.request_id) {
		throwInvalidNativeRequest("sandbox request_id must be a non-empty string");
	}
	if (
		typeof request.parent_pid !== "number" ||
		!Number.isSafeInteger(request.parent_pid) ||
		request.parent_pid <= 0 ||
		request.parent_pid > 0xffff_ffff
	) {
		throwInvalidNativeRequest(
			"sandbox parent_pid must be a positive 32-bit integer",
		);
	}
	if (
		request.execution_mode !== "workspace_write" &&
		request.execution_mode !== "danger_full_access"
	) {
		throwInvalidNativeRequest(
			"sandbox execution_mode must be workspace_write or danger_full_access",
		);
	}
	assertStringArray(request.args, "sandbox args");
	if (typeof request.cwd !== "string" || !request.cwd) {
		throwInvalidNativeRequest("sandbox cwd must be a non-empty string");
	}
	assertStringArray(request.writable_roots, "sandbox writable_roots");
	if (
		request.writable_roots.length === 0 ||
		request.writable_roots.length > 4
	) {
		throwInvalidNativeRequest(
			"sandbox writable_roots must contain between one and four paths",
		);
	}
	if (
		typeof request.env !== "object" ||
		request.env === null ||
		Array.isArray(request.env) ||
		Object.values(request.env).some((entry) => typeof entry !== "string")
	) {
		throwInvalidNativeRequest("sandbox env must map strings to strings");
	}
	for (const [key, minimum] of [
		["timeout_ms", 1],
		["max_output_bytes", 1],
	] as const) {
		const entry = request[key];
		if (
			typeof entry !== "number" ||
			!Number.isSafeInteger(entry) ||
			entry < minimum
		) {
			throwInvalidNativeRequest(`sandbox ${key} must be a positive integer`);
		}
	}
}

function assertStringArray(
	value: unknown,
	label: string,
): asserts value is string[] {
	if (
		!Array.isArray(value) ||
		value.some((entry) => typeof entry !== "string")
	) {
		throwInvalidNativeRequest(`${label} must be an array of strings`);
	}
}

function throwInvalidNativeRequest(message: string): never {
	throw new WindowsSandboxError(`${message}.`, { stage: "validate_request" });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new WindowsSandboxError(`${label} must be an object.`, {
			stage: "validate_response",
		});
	}
	return value as Record<string, unknown>;
}

function assertExactKeys(
	record: object,
	expected: ReadonlySet<string>,
	label: string,
	stage = "validate_response",
): void {
	const keys = Object.keys(record);
	const missing = [...expected].filter((key) => !keys.includes(key));
	const unknown = keys.filter((key) => !expected.has(key));
	if (missing.length > 0 || unknown.length > 0) {
		throw new WindowsSandboxError(
			`${label} keys do not match the protocol (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}).`,
			{ stage },
		);
	}
}

function hasExactKeys(record: object, expected: ReadonlySet<string>): boolean {
	const keys = Object.keys(record);
	return (
		keys.length === expected.size && keys.every((key) => expected.has(key))
	);
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") {
		throw new WindowsSandboxError(`${label} must be a string.`, {
			stage: "validate_response",
		});
	}
	return value;
}

function requireBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new WindowsSandboxError(`${label} must be a boolean.`, {
			stage: "validate_response",
		});
	}
	return value;
}

function requireInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new WindowsSandboxError(`${label} must be an integer.`, {
			stage: "validate_response",
		});
	}
	return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
	const result = requireInteger(value, label);
	if (result < 0) {
		throw new WindowsSandboxError(`${label} must not be negative.`, {
			stage: "validate_response",
		});
	}
	return result;
}

function requireEnum<const T extends string>(
	value: unknown,
	allowed: readonly T[],
	label: string,
): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new WindowsSandboxError(
			`${label} must be one of: ${allowed.join(", ")}.`,
			{ stage: "validate_response" },
		);
	}
	return value as T;
}

function formatHelperExit(
	code: number | null,
	signal: NodeJS.Signals | null,
	stderr: string,
): string {
	const exit = signal ? ` (signal ${signal})` : ` (exit ${String(code)})`;
	return `${exit}${formatHelperStderr(stderr)}`;
}

function formatHelperStderr(stderr: string): string {
	const trimmed = stderr.trim();
	return trimmed ? `; helper stderr: ${trimmed}` : "";
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw createAbortError(signal);
	}
}

function createAbortError(signal?: AbortSignal): Error {
	const reason = signal?.reason;
	const error = new Error(
		typeof reason === "string" && reason.trim()
			? reason
			: "Windows sandbox execution aborted.",
	);
	error.name = "AbortError";
	return error;
}
