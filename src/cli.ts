import { runCli } from "./main";

runCli()
	.then((exitCode) => {
		process.exitCode = exitCode;
	})
	.catch((caught) => {
		console.error(caught instanceof Error ? caught.message : String(caught));
		process.exitCode = 1;
	});
