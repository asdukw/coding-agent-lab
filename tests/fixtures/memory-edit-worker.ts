import { writeFile } from "node:fs/promises";
import {
	editValidatedMemoryFile,
	MemoryEditConflictError,
} from "../../src/memory";

const [cwd, topicPath, gatePath, readyPath, oldString, newString] =
	process.argv.slice(2);

if (
	!cwd ||
	!topicPath ||
	!gatePath ||
	!readyPath ||
	oldString === undefined ||
	newString === undefined
) {
	throw new Error("memory edit worker received incomplete arguments");
}

await writeFile(readyPath, "ready", "utf8");
while (!(await Bun.file(gatePath).exists())) {
	await Bun.sleep(5);
}

try {
	const result = await editValidatedMemoryFile(
		cwd,
		topicPath,
		oldString,
		newString,
	);
	process.stdout.write(`${JSON.stringify({ status: "success", result })}\n`);
} catch (caught) {
	process.stdout.write(
		`${JSON.stringify({
			status:
				caught instanceof MemoryEditConflictError ? "conflict" : "failure",
			message: caught instanceof Error ? caught.message : String(caught),
		})}\n`,
	);
}
