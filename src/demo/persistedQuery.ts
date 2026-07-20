import type { AutoCompactOptions } from "../compact";
import type { ModelClient } from "../model/client";
import { type QueryEvent, query, type Terminal } from "../query";
import {
	appendSessionCompaction,
	appendSessionMessage,
	appendSessionState,
	ensureSessionStarted,
} from "../sessionStore";
import type { AgentState } from "../state";
import type { Tools } from "../tools/types";

export type PersistenceCursor = {
	messageCount: number;
};

export async function runPersistedQueryCycle({
	state,
	model,
	tools,
	cursor,
	signal,
	autoCompactOptions = { maxContextChars: Number.MAX_SAFE_INTEGER },
	onEvent,
}: {
	state: AgentState;
	model: ModelClient;
	tools: Tools;
	cursor: PersistenceCursor;
	signal?: AbortSignal;
	autoCompactOptions?: AutoCompactOptions;
	onEvent?: (event: QueryEvent) => void | Promise<void>;
}): Promise<{ terminal: Terminal; state: AgentState }> {
	await ensureSessionStarted(state.cwd, state);
	for (const message of state.messages.slice(cursor.messageCount)) {
		await appendSessionMessage(state.cwd, state, message);
	}
	cursor.messageCount = state.messages.length;

	let terminal: Terminal | undefined;
	let statePersisted = false;
	for await (const event of query({
		initialState: state,
		model,
		tools,
		enableMemoryExtraction: false,
		autoCompactOptions,
		signal,
	})) {
		await persistEvent(state.cwd, state, event);
		if (event.type === "message") {
			cursor.messageCount += 1;
		} else if (event.type === "state") {
			statePersisted = true;
		} else if (event.type === "terminal") {
			terminal = event.terminal;
			if (!statePersisted) {
				await appendSessionState(state.cwd, event.terminal.state);
			}
		}
		await onEvent?.(event);
	}

	if (!terminal) {
		throw new Error("demo query ended without a terminal event");
	}
	cursor.messageCount = terminal.state.messages.length;
	return { terminal, state: terminal.state };
}

async function persistEvent(
	cwd: string,
	initialState: AgentState,
	event: QueryEvent,
): Promise<void> {
	if (event.type === "message") {
		await appendSessionMessage(cwd, initialState, event.message);
	} else if (event.type === "state") {
		await appendSessionState(cwd, event.state);
	} else if (event.type === "compaction") {
		await appendSessionCompaction(cwd, event.state);
	}
}
