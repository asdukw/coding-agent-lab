import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ensureMemoryStore, formatMemoryStoreSummary } from "../memory";
import { runMemoryExtractionSubAgent } from "../memoryExtract";
import type { ModelClient } from "../model/client";
import { query } from "../query";
import {
	appendSessionMessage,
	appendSessionState,
	ensureSessionStarted,
	loadSession,
	persistSessionMemoryExtraction,
} from "../sessionStore";
import {
	type AgentState,
	continueState,
	createInitialState,
	enterPlanMode,
	resolvePlanApproval,
} from "../state";
import { BUILTIN_TOOLS } from "../tools";
import { type Tools, toToolSpecs } from "../tools/types";
import { parseLocalCommand } from "./localCommands";
import { Markdown } from "./Markdown";

export type AppProps = {
	task?: string;
	cwd: string;
	model: ModelClient;
	initialState?: AgentState;
	mcpTools?: Tools;
};

type Turn = {
	id: string;
	user: string;
	assistant: string;
};

function historyFromState(state: AgentState | undefined): Turn[] {
	if (!state) {
		return [];
	}

	const turns: Turn[] = [];
	let pendingUser: string | undefined;
	let id = 0;

	for (const message of state.messages) {
		if (message.role === "user") {
			pendingUser = message.content;
		} else if (
			message.role === "assistant" &&
			pendingUser !== undefined &&
			message.content.trim()
		) {
			turns.push({
				id: `${state.sessionId}:${id++}`,
				user: pendingUser,
				assistant: message.content,
			});
			pendingUser = undefined;
		}
	}

	return turns;
}

export function App({
	task,
	cwd,
	model,
	initialState: restoredState,
	mcpTools = [],
}: AppProps) {
	const tools = useMemo(() => [...BUILTIN_TOOLS, ...mcpTools], [mcpTools]);
	const [modelName, setModelName] = useState<string | undefined>();
	const [agentState, setAgentState] = useState<AgentState | undefined>(
		restoredState,
	);
	const [history, setHistory] = useState<Turn[]>(
		historyFromState(restoredState),
	);
	const [streamingText, setStreamingText] = useState("");
	const [status, setStatus] = useState<"idle" | "running">("idle");
	const [input, setInput] = useState("");
	const [error, setError] = useState<string | undefined>();

	const runState = useCallback(
		(
			initialState: AgentState,
			userText: string,
			persistFromMessageIndex: number,
		) => {
			if (status === "running") {
				return;
			}

			setStatus("running");
			setStreamingText("");
			setError(undefined);

			let assistantText = "";

			void (async () => {
				try {
					await ensureSessionStarted(cwd, initialState);
					for (const message of initialState.messages.slice(
						persistFromMessageIndex,
					)) {
						await appendSessionMessage(cwd, initialState, message);
					}

					let statePersisted = false;
					for await (const event of query({
						initialState,
						model,
						tools,
					})) {
						if (event.type === "request_start") {
							setModelName(event.model);
						} else if (event.type === "stream_delta") {
							assistantText += event.content;
							setStreamingText(assistantText);
						} else if (event.type === "message") {
							await appendSessionMessage(cwd, initialState, event.message);
						} else if (event.type === "state") {
							await appendSessionState(cwd, event.state);
							statePersisted = true;
						} else if (event.type === "memory_extraction_request") {
							void runMemoryExtractionSubAgent({
								state: event.state,
								model,
							})
								.catch((caught) => ({
									subAgentSessionId: `${event.state.sessionId}.memory.${event.state.turn}`,
									ok: false,
									reason: "query_error",
									reasons: ["query_error"],
									summary: `memory extraction crashed: ${formatCaught(caught)}`,
								}))
								.then((result) =>
									persistSessionMemoryExtraction(cwd, event.state, result),
								)
								.catch((caught) => {
									process.stderr.write(
										`memory extraction audit persistence failed: ${formatCaught(caught)}\n`,
									);
								});
						} else if (event.type === "terminal") {
							if (!statePersisted) {
								await appendSessionState(cwd, event.terminal.state);
							}
							setAgentState(event.terminal.state);
							setHistory((current) => [
								...current,
								{
									id: `${event.terminal.state.sessionId}:${event.terminal.state.turn}`,
									user: userText,
									assistant: assistantText,
								},
							]);
							setStreamingText("");
							setStatus("idle");
						}
					}
				} catch (caught) {
					setError(caught instanceof Error ? caught.message : String(caught));
					setStatus("idle");
				}
			})();
		},
		[cwd, model, status, tools],
	);

	const runTurn = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (!trimmed || status === "running") {
				return;
			}

			const initialState = agentState
				? continueState(agentState, trimmed)
				: createInitialState(trimmed, cwd, toToolSpecs(tools));

			runState(initialState, trimmed, agentState?.messages.length ?? 0);
		},
		[agentState, cwd, runState, status, tools],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs once on mount, not on every task/runTurn change
	useEffect(() => {
		if (task) {
			runTurn(task);
		}
	}, []);

	const handleSubmit = (value: string) => {
		setInput("");
		const approval = parsePlanApprovalInput(value);
		if (agentState?.toolPermissionContext.pendingPlanApproval) {
			if (!approval) {
				setError(
					'Type "approve" to continue or "reject <feedback>" to revise.',
				);
				return;
			}

			const nextState = resolvePlanApproval(
				agentState,
				approval.decision,
				approval.feedback,
			);
			runState(
				nextState,
				approval.decision === "approve"
					? "approve plan"
					: `reject plan${approval.feedback ? `: ${approval.feedback}` : ""}`,
				agentState.messages.length,
			);
			return;
		}

		const localCommand = parseLocalCommand(value);
		if (localCommand) {
			if (localCommand.type === "invalid") {
				setError(localCommand.message);
				return;
			}

			if (localCommand.type === "unknown") {
				setError(`unknown command: ${localCommand.name}`);
				return;
			}

			if (localCommand.type === "resume") {
				setError(undefined);
				setStreamingText("");
				void (async () => {
					try {
						const restored = await loadSession(cwd, localCommand.sessionId);
						setAgentState(restored);
						setHistory(historyFromState(restored));
					} catch (caught) {
						setError(caught instanceof Error ? caught.message : String(caught));
					}
				})();
				return;
			}

			if (localCommand.type === "memory") {
				setError(undefined);
				setStreamingText("");
				void (async () => {
					try {
						const info = await ensureMemoryStore(cwd);
						setHistory((current) => [
							...current,
							{
								id: `local-${current.length + 1}`,
								user: "/memory",
								assistant: formatMemoryStoreSummary(info),
							},
						]);
					} catch (caught) {
						setError(caught instanceof Error ? caught.message : String(caught));
					}
				})();
				return;
			}

			if (localCommand.type === "enter_plan_mode") {
				const nextState = enterPlanMode(
					agentState ?? createInitialState("/plan", cwd, toToolSpecs(tools)),
				);
				setAgentState(nextState);
				setHistory((current) => [
					...current,
					{
						id: `local-${current.length + 1}`,
						user: "/plan",
						assistant:
							"Entered plan mode.\n\nThe plan is stored as runtime state only.",
					},
				]);
				setError(undefined);
			}
			return;
		}

		runTurn(value);
	};

	const pendingPlanApproval =
		agentState?.toolPermissionContext.pendingPlanApproval;

	return (
		<Box flexDirection="column" gap={1}>
			<Box flexDirection="column">
				<Text color="cyan">cagent</Text>
				<Text color="gray">cwd: {cwd}</Text>
				{agentState ? (
					<Text color="gray">session: {agentState.sessionId}</Text>
				) : null}
				{modelName ? <Text color="gray">model: {modelName}</Text> : null}
			</Box>

			{history.map((turn) => (
				<Box flexDirection="column" key={turn.id}>
					<Box flexDirection="column">
						<Text color="green">user</Text>
						<Text>{turn.user}</Text>
					</Box>
					<Box flexDirection="column">
						<Text color="blue">assistant</Text>
						<Markdown>{turn.assistant}</Markdown>
					</Box>
				</Box>
			))}

			{status === "running" ? (
				<Box flexDirection="column">
					<Text color="blue">assistant</Text>
					{streamingText ? (
						<Markdown>{streamingText}</Markdown>
					) : (
						<Text>...</Text>
					)}
				</Box>
			) : null}

			{error ? <Text color="red">error: {error}</Text> : null}

			{pendingPlanApproval ? (
				<Box
					borderStyle="round"
					borderColor="yellow"
					flexDirection="column"
					paddingX={1}
				>
					<Text color="yellow">plan approval</Text>
					<Markdown>{pendingPlanApproval.plan}</Markdown>
					<Text color="gray">
						Type "approve" to continue or "reject &lt;feedback&gt;" to revise.
					</Text>
				</Box>
			) : null}

			{status === "idle" ? (
				<Box borderStyle="round" borderColor="cyan" paddingX={1}>
					<Text color="green">{"> "}</Text>
					<TextInput
						value={input}
						onChange={setInput}
						onSubmit={handleSubmit}
						placeholder={
							pendingPlanApproval
								? "approve or reject with feedback..."
								: "Type a message and press Enter..."
						}
					/>
				</Box>
			) : null}
		</Box>
	);
}

function formatCaught(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}

function parsePlanApprovalInput(
	value: string,
): { decision: "approve" | "reject"; feedback: string } | undefined {
	const trimmed = value.trim();
	const lower = trimmed.toLowerCase();

	if (["approve", "approved", "yes", "y"].includes(lower)) {
		return { decision: "approve", feedback: "" };
	}

	if (lower === "reject" || lower.startsWith("reject ")) {
		return {
			decision: "reject",
			feedback: trimmed.slice("reject".length).trim(),
		};
	}

	if (lower === "no" || lower.startsWith("no ")) {
		return {
			decision: "reject",
			feedback: trimmed.slice("no".length).trim(),
		};
	}

	return undefined;
}
