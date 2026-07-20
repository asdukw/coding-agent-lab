import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const testFiles: string[] = [];
for await (const path of new Bun.Glob("tests/**/*.test.ts").scan({
	cwd: repoRoot,
	onlyFiles: true,
})) {
	const normalized = path.replaceAll("\\", "/");
	if (
		normalized === "tests/deepseekConnectivity.test.ts" ||
		normalized.startsWith("tests/integration/")
	) {
		continue;
	}
	testFiles.push(normalized);
}
testFiles.sort();

if (testFiles.length === 0) {
	throw new Error("No offline unit test files were discovered.");
}

for (const [index, testFile] of testFiles.entries()) {
	console.log(`[unit ${index + 1}/${testFiles.length}] ${testFile}`);
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", "test", testFile],
		{
			cwd: repoRoot,
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	const exitCode = await child.exited;
	if (exitCode !== 0) {
		throw new Error(`${testFile} failed with exit code ${exitCode}.`);
	}
}

console.log(`Offline unit suite passed: ${testFiles.length} files.`);
