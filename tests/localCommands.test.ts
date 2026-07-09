import { expect, test } from "bun:test";
import { parseLocalCommand } from "../src/ui/localCommands";

test("parseLocalCommand returns undefined for regular user input", () => {
	expect(parseLocalCommand("hello")).toBeUndefined();
});

test("parseLocalCommand parses plan commands", () => {
	expect(parseLocalCommand("/plan")).toEqual({
		type: "enter_plan_mode",
	});
});

test("parseLocalCommand parses memory commands", () => {
	expect(parseLocalCommand("/memory")).toEqual({
		type: "memory",
	});
});

test("parseLocalCommand parses resume commands", () => {
	expect(parseLocalCommand("/resume session-1")).toEqual({
		type: "resume",
		sessionId: "session-1",
	});
});

test("parseLocalCommand rejects malformed resume commands", () => {
	expect(parseLocalCommand("/resume")).toEqual({
		type: "invalid",
		message: "usage: /resume <session-id>",
	});

	expect(parseLocalCommand("/resume one two")).toEqual({
		type: "invalid",
		message: "usage: /resume <session-id>",
	});
});

test("parseLocalCommand reports unknown slash commands", () => {
	expect(parseLocalCommand("/clear")).toEqual({
		type: "unknown",
		name: "/clear",
	});
});
