import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

type RipgrepResult = {
	stdout: string;
	exitCode: number;
};

export async function runRipgrep(
	args: string[],
	options: {
		cwd: string;
		signal?: AbortSignal;
	},
): Promise<RipgrepResult> {
	let subprocess: Bun.Subprocess<"ignore", "pipe", "pipe">;
	const executable = resolveRipgrepExecutable();
	try {
		subprocess = Bun.spawn([executable, ...args], {
			cwd: options.cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			signal: options.signal,
		});
	} catch (caught) {
		throw new Error(
			`Unable to start ripgrep (${executable}). Ensure the bundled rg.exe is present or rg is available on PATH: ${
				caught instanceof Error ? caught.message : String(caught)
			}`,
			{ cause: caught },
		);
	}

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
		subprocess.exited,
	]);
	if (exitCode !== 0 && exitCode !== 1) {
		throw new Error(
			`ripgrep exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
		);
	}
	return { stdout, exitCode };
}

export function resolveRipgrepExecutable(): string {
	if (process.platform === "win32") {
		const bundledExecutable = join(dirname(process.execPath), "rg.exe");
		if (existsSync(bundledExecutable)) {
			return bundledExecutable;
		}
	}
	return "rg";
}
