import { render } from "ink";
import { createModelClientFromEnv } from "./model";
import { App } from "./ui/App";

function main(): void {
	const task = process.argv.slice(2).join(" ") || undefined;
	const model = createModelClientFromEnv();

	render(<App task={task} cwd={process.cwd()} model={model} />);
}

main();
