import { runCli } from "./main";

runCli().catch((caught) => {
	console.error(caught instanceof Error ? caught.message : String(caught));
	process.exitCode = 1;
});
