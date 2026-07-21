import { readFile, writeFile } from "node:fs/promises";
import { writeValidatedMemoryFile } from "../../src/memory";

const [cwd, topicPath, contentPath, gatePath, readyPath] =
	process.argv.slice(2);

if (!cwd || !topicPath || !contentPath || !gatePath || !readyPath) {
	throw new Error("memory write worker received incomplete arguments");
}

await writeFile(readyPath, "ready", "utf8");
while (!(await Bun.file(gatePath).exists())) {
	await Bun.sleep(5);
}

try {
	const content = await readFile(contentPath, "utf8");
	const bytesWritten = await writeValidatedMemoryFile(cwd, topicPath, content);
	process.stdout.write(
		`${JSON.stringify({ status: "success", bytesWritten })}\n`,
	);
} catch (caught) {
	process.stdout.write(
		`${JSON.stringify({
			status: "failure",
			message: caught instanceof Error ? caught.message : String(caught),
		})}\n`,
	);
}
