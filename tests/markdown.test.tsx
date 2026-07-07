import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Markdown } from "../src/ui/Markdown";

test("renders common markdown syntax without raw markup markers", () => {
	const { lastFrame, unmount } = render(
		<Markdown>{`## Title

This is **bold** with \`code\` and [docs](https://example.com).

- first
1. second

> quoted

\`\`\`ts
const value = 1;
\`\`\``}</Markdown>,
	);

	const frame = lastFrame() ?? "";
	expect(frame).toContain("Title");
	expect(frame).toContain("This is bold with code and docs.");
	expect(frame).toContain("- first");
	expect(frame).toContain("1. second");
	expect(frame).toContain("| quoted");
	expect(frame).toContain("const value = 1;");
	expect(frame).not.toContain("## Title");
	expect(frame).not.toContain("**bold**");
	expect(frame).not.toContain("`code`");
	expect(frame).not.toContain("[docs](https://example.com)");
	expect(frame).not.toContain("```");

	unmount();
});
