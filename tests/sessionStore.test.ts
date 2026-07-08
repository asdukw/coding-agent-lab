import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../src/main";
import { getSessionPath, loadSession, saveSession } from "../src/sessionStore";
import { createInitialState } from "../src/state";

test("saveSession writes AgentState and loadSession restores it", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cagent-session-"));
	try {
		const state = createInitialState("hello", cwd, [], "session-1");
		const path = await saveSession(cwd, state);

		expect(path).toBe(getSessionPath(cwd, "session-1"));
		const raw = await readFile(path, "utf8");
		expect(raw).toContain('"version": 1');
		expect(raw).toContain('"id": "session-1"');

		await expect(loadSession(cwd, "session-1")).resolves.toEqual(state);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("session ids cannot escape the sessions directory", () => {
	expect(() => getSessionPath("/repo", "../outside")).toThrow(
		"invalid session id",
	);
});

test("parseCliArgs supports resume id and preserves task text", () => {
	expect(parseCliArgs(["--resume", "session-1", "continue", "work"])).toEqual({
		resumeId: "session-1",
		task: "continue work",
	});

	expect(parseCliArgs(["--resume=session-2"])).toEqual({
		resumeId: "session-2",
		task: undefined,
	});
});
