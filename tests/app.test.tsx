import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { StubModelClient } from "../src/model/stub";
import { App } from "../src/ui/App";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("interactive dialog box drives a multi-turn conversation", async () => {
	const model = new StubModelClient();
	const { lastFrame, stdin, unmount } = render(
		<App cwd="/repo" model={model} />,
	);

	await wait(100);
	expect(lastFrame()).toContain("Type a message and press Enter...");

	stdin.write("hello there");
	await wait(100);
	expect(lastFrame()).toContain("hello there");

	stdin.write("\r");
	await wait(300);

	let frame = lastFrame() ?? "";
	expect(frame).toContain("user");
	expect(frame).toContain("hello there");
	expect(frame).toContain("Stub agent received task: hello there");
	expect(frame).toContain("Type a message and press Enter...");

	stdin.write("second message");
	await wait(100);
	expect(lastFrame()).toContain("second message");

	stdin.write("\r");
	await wait(300);

	frame = lastFrame() ?? "";
	expect(frame).toContain("hello there");
	expect(frame).toContain("Stub agent received task: hello there");
	expect(frame).toContain("second message");
	expect(frame).toContain("Stub agent received task: second message");

	unmount();
});
