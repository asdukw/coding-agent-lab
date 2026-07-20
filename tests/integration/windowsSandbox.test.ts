import { expect, test } from "bun:test";
import {
	copyFile,
	link,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	WindowsSandbox,
	WindowsSandboxError,
} from "../../src/sandbox/windowsSandbox";

const integrationEnabled =
	process.platform === "win32" &&
	process.env.CAGENT_WINDOWS_SANDBOX_INTEGRATION === "1";
const integrationTest = integrationEnabled ? test : test.skip;

integrationTest(
	"native Windows sandbox enforces the end-to-end security contract",
	async () => {
		const helperPath = process.env.CAGENT_WINDOWS_SANDBOX_HELPER;
		if (!helperPath) {
			throw new Error(
				"CAGENT_WINDOWS_SANDBOX_HELPER must name the release runner",
			);
		}

		const testRoot = await mkdtemp(
			join(process.env.RUNNER_TEMP ?? tmpdir(), "cagent-sandbox-e2e-"),
		);
		const workspace = join(testRoot, "workspace");
		const outsideSentinel = join(testRoot, "outside-sentinel.txt");
		const outsideHardlinkTarget = join(testRoot, "bun-cache-entry.txt");
		const workspaceHardlink = join(workspace, "linked-dependency.txt");
		const fullAccessOutput = join(testRoot, "full-access-output.txt");
		const environmentSecret = "must-not-cross-the-sandbox-boundary";
		const previousSecret = process.env.CAGENT_E2E_SECRET;

		try {
			await mkdir(join(workspace, ".git", "hooks"), { recursive: true });
			await writeFile(join(workspace, ".git", "config"), "git-safe\n", "utf8");
			await writeFile(join(workspace, ".env.test"), "env-safe\n", "utf8");
			await writeFile(join(workspace, "AGENTS.md"), "agents-safe\n", "utf8");
			await writeFile(outsideSentinel, "outside-safe\n", "utf8");
			await writeFile(outsideHardlinkTarget, "cache-safe\n", "utf8");
			await link(outsideHardlinkTarget, workspaceHardlink);

			const inWorkspaceHelper = join(workspace, basename(helperPath));
			await copyFile(helperPath, inWorkspaceHelper);
			try {
				await WindowsSandbox.create(workspace, {
					helperPath: inWorkspaceHelper,
				});
				throw new Error("an in-workspace helper was unexpectedly accepted");
			} catch (caught) {
				expect(caught).toBeInstanceOf(WindowsSandboxError);
				expect((caught as WindowsSandboxError).stage).toBe("validate_helper");
			}
			await rm(inWorkspaceHelper, { force: true });

			process.env.CAGENT_E2E_SECRET = environmentSecret;
			const sandbox = await WindowsSandbox.create(workspace, { helperPath });
			restoreEnvironment("CAGENT_E2E_SECRET", previousSecret);

			const roundTrip = await sandbox.runPowerShell({
				command: [
					"Set-Content -LiteralPath 'allowed.txt' -Value 'inside-ok'",
					"Write-Output 'e2e-stdout'",
					"[Console]::Error.WriteLine('e2e-stderr')",
					"exit 7",
				].join("\n"),
			});
			expect(roundTrip.exitCode).toBe(7);
			expect(roundTrip.stdout).toContain("e2e-stdout");
			expect(roundTrip.stderr).toContain("e2e-stderr");
			expect(roundTrip.timedOut).toBe(false);
			expect(roundTrip.enforcement).toEqual({
				filesystem: "write_restricted_acl",
				process_tree: "job_members_kill_on_close",
				network: "inherited_not_isolated",
			});
			expect(await readFile(join(workspace, "allowed.txt"), "utf8")).toContain(
				"inside-ok",
			);

			const hardlinkRead = await sandbox.runPowerShell({
				command:
					"Write-Output (Get-Content -LiteralPath 'linked-dependency.txt' -Raw -ErrorAction Stop)",
			});
			expect(hardlinkRead.exitCode).toBe(0);
			expect(hardlinkRead.stdout).toContain("cache-safe");

			const hardlinkAttempt = await sandbox.runPowerShell({
				command: [
					"try {",
					"  Set-Content -LiteralPath 'linked-dependency.txt' -Value 'tampered' -ErrorAction Stop",
					"  exit 0",
					"} catch {",
					"  Write-Output 'hardlink-write-denied'",
					"  exit 29",
					"}",
				].join("\n"),
			});
			expect(hardlinkAttempt.exitCode).toBe(29);
			expect(hardlinkAttempt.stdout).toContain("hardlink-write-denied");
			expect(await readFile(workspaceHardlink, "utf8")).toBe("cache-safe\n");
			expect(await readFile(outsideHardlinkTarget, "utf8")).toBe(
				"cache-safe\n",
			);

			const outsideAttempt = await sandbox.runPowerShell({
				command: [
					"try {",
					`  Set-Content -LiteralPath ${powerShellLiteral(outsideSentinel)} -Value 'tampered' -ErrorAction Stop`,
					"  exit 0",
					"} catch {",
					"  Write-Output 'outside-write-denied'",
					"  exit 23",
					"}",
				].join("\n"),
			});
			expect(outsideAttempt.exitCode).toBe(23);
			expect(outsideAttempt.stdout).toContain("outside-write-denied");
			expect(await readFile(outsideSentinel, "utf8")).toBe("outside-safe\n");

			const protectedAttempt = await sandbox.runPowerShell({
				command: [
					"$changed = @()",
					"foreach ($path in @('.env.test', 'AGENTS.md', '.git\\config')) {",
					"  try {",
					"    Set-Content -LiteralPath $path -Value 'tampered' -ErrorAction Stop",
					"    $changed += $path",
					"  } catch {}",
					"}",
					"if ($changed.Count -gt 0) { Write-Error ($changed -join ','); exit 41 }",
					"Write-Output 'protected-writes-denied'",
				].join("\n"),
			});
			expect(protectedAttempt.exitCode).toBe(0);
			expect(protectedAttempt.stdout).toContain("protected-writes-denied");
			expect(await readFile(join(workspace, ".env.test"), "utf8")).toBe(
				"env-safe\n",
			);
			expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe(
				"agents-safe\n",
			);
			expect(await readFile(join(workspace, ".git", "config"), "utf8")).toBe(
				"git-safe\n",
			);

			const environmentAttempt = await sandbox.runPowerShell({
				command: [
					"if (Test-Path Env:CAGENT_E2E_SECRET) { exit 31 }",
					"Write-Output 'environment-redacted'",
				].join("\n"),
			});
			expect(environmentAttempt.exitCode).toBe(0);
			expect(environmentAttempt.stdout).toContain("environment-redacted");
			expect(environmentAttempt.stdout).not.toContain(environmentSecret);

			process.env.CAGENT_E2E_SECRET = environmentSecret;
			const fullAccess = await sandbox.runPowerShell({
				executionMode: "danger_full_access",
				command: [
					`Set-Content -LiteralPath ${powerShellLiteral(fullAccessOutput)} -Value 'host-write' -ErrorAction Stop`,
					"Write-Output $env:CAGENT_E2E_SECRET",
				].join("\n"),
			});
			restoreEnvironment("CAGENT_E2E_SECRET", previousSecret);
			expect(fullAccess.exitCode).toBe(0);
			expect(fullAccess.stdout).toContain(environmentSecret);
			expect(fullAccess.enforcement).toEqual({
				filesystem: "unrestricted",
				process_tree: "job_members_kill_on_close",
				network: "inherited_unrestricted",
			});
			expect(await readFile(fullAccessOutput, "utf8")).toContain("host-write");

			const truncatingSandbox = await WindowsSandbox.create(workspace, {
				helperPath,
				maxOutputBytes: 1_024,
			});
			const truncated = await truncatingSandbox.runPowerShell({
				command: "Write-Output ('x' * 4096)",
			});
			expect(truncated.exitCode).toBe(0);
			expect(truncated.stdoutTruncated).toBe(true);
			expect(Buffer.byteLength(truncated.stdout, "utf8")).toBeLessThanOrEqual(
				1_024,
			);

			const childMarker = join(workspace, "child-marker.txt");
			const childPidPath = join(workspace, "child.pid");
			const childScript = [
				"Start-Sleep -Seconds 30",
				`Set-Content -LiteralPath ${powerShellLiteral(childMarker)} -Value 'survived'`,
			].join("\n");
			const encodedChild = Buffer.from(childScript, "utf16le").toString(
				"base64",
			);
			const timedOut = await sandbox.runPowerShell({
				command: [
					"$powershell = Join-Path $PSHOME 'pwsh.exe'",
					`$child = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', '${encodedChild}') -WindowStyle Hidden -PassThru`,
					"Set-Content -LiteralPath 'child.pid' -Value $child.Id",
					"Start-Sleep -Seconds 60",
				].join("\n"),
				timeoutMs: 3_000,
			});
			expect(timedOut.timedOut).toBe(true);
			expect(timedOut.exitCode).not.toBe(0);
			const childPid = Number((await readFile(childPidPath, "utf8")).trim());
			expect(Number.isSafeInteger(childPid)).toBe(true);
			expect(await waitForProcessExit(childPid, 5_000)).toBe(true);
			expect(await pathExists(childMarker)).toBe(false);

			const afterTimeout = await sandbox.runPowerShell({
				command: "Write-Output 'usable-after-timeout'",
			});
			expect(afterTimeout.exitCode).toBe(0);
			expect(afterTimeout.stdout).toContain("usable-after-timeout");
			expect(
				await readdir(join(workspace, ".cagent-sandbox", "profiles")),
			).toEqual([]);
		} finally {
			restoreEnvironment("CAGENT_E2E_SECRET", previousSecret);
			await rm(testRoot, { recursive: true, force: true });
		}
	},
	45_000,
);

function powerShellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

async function waitForProcessExit(
	pid: number,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processExists(pid)) {
			return true;
		}
		await delay(50);
	}
	return !processExists(pid);
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (caught) {
		return !(
			caught instanceof Error &&
			"code" in caught &&
			(caught as NodeJS.ErrnoException).code === "ESRCH"
		);
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
