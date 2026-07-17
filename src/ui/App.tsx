import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InProcessAgentManager } from "../agents/manager";
import { ensureMemoryStore, formatMemoryStoreSummary } from "../memory";
import { runMemoryExtractionSubAgent } from "../memoryExtract";
import type { ModelClient } from "../model/client";
import { query } from "../query";
import {
	appendSessionCompaction,
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
	resolveToolApproval,
	type ToolApprovalDecision,
} from "../state";
import { BUILTIN_TOOLS } from "../tools";
import { type Tools, toToolSpecs } from "../tools/types";
import { type AppLifecycle, createAppLifecycle } from "./appLifecycle";
import { parseLocalCommand } from "./localCommands";
import { Markdown } from "./Markdown";

export type AppProps = {
	task?: string;
	cwd: string;
	model: ModelClient;
	initialState?: AgentState;
	mcpTools?: Tools;
	enableMemoryExtraction?: boolean;
	lifecycle?: AppLifecycle;
};

const EMPTY_TOOLS: Tools = [];

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
		} else if (message.role === "agent") {
			pendingUser = "Sub-agent update";
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
	mcpTools = EMPTY_TOOLS,
	enableMemoryExtraction = true,
	lifecycle,
}: AppProps) {
	const fallbackLifecycle = useMemo(() => createAppLifecycle(), []);
	const appLifecycle = lifecycle ?? fallbackLifecycle;
	const tools = useMemo(() => [...BUILTIN_TOOLS, ...mcpTools], [mcpTools]);
	const agentRuntime = useMemo(
		() =>
			new InProcessAgentManager({
				model,
				getTools: () => tools,
			}),
		[model, tools],
	);
	const [modelName, setModelName] = useState<string | undefined>();
	const [agentState, setAgentState] = useState<AgentState | undefined>(
		restoredState,
	);
	const [history, setHistory] = useState<Turn[]>(
		historyFromState(restoredState),
	);
	const [streamingText, setStreamingText] = useState("");
	const [status, setStatus] = useState<"idle" | "running">("idle");
	const runInFlightRef = useRef(false);
	const [input, setInput] = useState("");
	const [error, setError] = useState<string | undefined>();
	const [agentInboxRevision, setAgentInboxRevision] = useState(0);

	const runState = useCallback(
		(
			initialState: AgentState,
			userText: string,
			persistFromMessageIndex: number,
		) => {
			if (runInFlightRef.current || appLifecycle.isClosing) {
				return;
			}

			runInFlightRef.current = true;
			setStatus("running");
			setStreamingText("");
			setError(undefined);

			let assistantText = "";
			let latestState = initialState;

			const runPromise = (async () => {
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
						agentRuntime,
						enableMemoryExtraction,
						signal: appLifecycle.signal,
					})) {
						if (event.type === "request_start") {
							if (!appLifecycle.isClosing) {
								setModelName(event.model);
							}
						} else if (event.type === "stream_delta") {
							assistantText += event.content;
							if (!appLifecycle.isClosing) {
								setStreamingText(assistantText);
							}
						} else if (event.type === "message") {
							await appendSessionMessage(cwd, initialState, event.message);
						} else if (event.type === "state") {
							latestState = event.state;
							await appendSessionState(cwd, event.state);
							statePersisted = true;
						} else if (event.type === "compaction") {
							latestState = event.state;
							await appendSessionCompaction(cwd, event.state);
						} else if (event.type === "memory_extraction_request") {
							if (appLifecycle.isClosing) {
								continue;
							}
							const extractionTask = runMemoryExtractionSubAgent({
								state: event.state,
								model,
								signal: appLifecycle.signal,
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
							appLifecycle.track(extractionTask);
						} else if (event.type === "terminal") {
							latestState = event.terminal.state;
							if (!statePersisted) {
								await appendSessionState(cwd, event.terminal.state);
							}
							if (!appLifecycle.isClosing) {
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
							}
						}
					}
				} catch (caught) {
					if (!appLifecycle.isClosing) {
						setAgentState(latestState);
						setError(caught instanceof Error ? caught.message : String(caught));
						setStreamingText("");
					}
				} finally {
					runInFlightRef.current = false;
					if (!appLifecycle.isClosing) {
						setStatus("idle");
					}
				}
			})();
			appLifecycle.track(runPromise);
		},
		[appLifecycle, agentRuntime, cwd, enableMemoryExtraction, model, tools],
	);

	const runTurn = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (!trimmed || status === "running" || appLifecycle.isClosing) {
				return;
			}
			if (
				agentState?.toolPermissionContext.pendingToolApproval ||
				agentState?.toolPermissionContext.pendingPlanApproval
			) {
				setError("Resolve the pending approval before starting a new turn.");
				return;
			}

			const initialState = agentState
				? continueState(agentState, trimmed)
				: createInitialState(trimmed, cwd, toToolSpecs(tools));

			runState(initialState, trimmed, agentState?.messages.length ?? 0);
		},
		[agentState, appLifecycle, cwd, runState, status, tools],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs once on mount, not on every task/runTurn change
	useEffect(() => {
		if (task) {
			runTurn(task);
		}
	}, []);

	useEffect(
		() =>
			agentRuntime.subscribe((event) => {
				if (event.type === "inbox" && !appLifecycle.isClosing) {
					setAgentInboxRevision((revision) => revision + 1);
				}
			}),
		[agentRuntime, appLifecycle],
	);

	useEffect(() => {
		appLifecycle.registerStopProducer(async () => {
			await agentRuntime.shutdown();
		});
		return () => {
			if (!appLifecycle.isClosing) {
				void agentRuntime.shutdown().catch(() => undefined);
			}
		};
	}, [agentRuntime, appLifecycle]);

	useEffect(() => {
		return () => {
			void appLifecycle.shutdown().catch(() => undefined);
		};
	}, [appLifecycle]);

	useEffect(() => {
		void agentInboxRevision;
		if (
			status !== "idle" ||
			!agentState ||
			agentState.toolPermissionContext.pendingPlanApproval ||
			agentState.toolPermissionContext.pendingToolApproval ||
			agentState.transition?.reason === "max_turns" ||
			agentState.budget.turnsUsed >= agentState.budget.maxTurns ||
			!agentRuntime.hasPendingMessages(agentState.agent.id)
		) {
			return;
		}
		runState(agentState, "sub-agent notification", agentState.messages.length);
	}, [agentInboxRevision, agentRuntime, agentState, runState, status]);

	useEffect(() => {
		if (
			status !== "idle" ||
			!agentState?.toolPermissionContext.pendingToolApproval?.needsRevalidation
		) {
			return;
		}
		runState(
			agentState,
			"refresh restored tool approval",
			agentState.messages.length,
		);
	}, [agentState, runState, status]);

	const handleSubmit = (value: string) => {
		if (appLifecycle.isClosing) {
			return;
		}
		setInput("");
		const toolApproval = parseToolApprovalInput(value);
		if (agentState?.toolPermissionContext.pendingToolApproval) {
			if (
				agentState.toolPermissionContext.pendingToolApproval.needsRevalidation
			) {
				setError(
					"Refreshing restored tool approval details; try again shortly.",
				);
				runState(
					agentState,
					"refresh restored tool approval",
					agentState.messages.length,
				);
				return;
			}
			if (!toolApproval) {
				setError(
					'Type "allow" for this batch, "always" for this session, or "deny".',
				);
				return;
			}

			const nextState = resolveToolApproval(agentState, toolApproval);
			const approvalLabel =
				toolApproval === "allow_once"
					? "allow tool calls once"
					: toolApproval === "allow_session"
						? "always allow these tools for this session"
						: "deny tool calls";
			runState(nextState, approvalLabel, agentState.messages.length);
			return;
		}

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
				const resumeTask = (async () => {
					try {
						const restored = await loadSession(cwd, localCommand.sessionId);
						if (!appLifecycle.isClosing) {
							setAgentState(restored);
							setHistory(historyFromState(restored));
						}
					} catch (caught) {
						if (!appLifecycle.isClosing) {
							setError(
								caught instanceof Error ? caught.message : String(caught),
							);
						}
					}
				})();
				appLifecycle.track(resumeTask);
				return;
			}

			if (localCommand.type === "memory") {
				setError(undefined);
				setStreamingText("");
				const memoryTask = (async () => {
					try {
						const info = await ensureMemoryStore(cwd);
						if (!appLifecycle.isClosing) {
							setHistory((current) => [
								...current,
								{
									id: `local-${current.length + 1}`,
									user: "/memory",
									assistant: formatMemoryStoreSummary(info),
								},
							]);
						}
					} catch (caught) {
						if (!appLifecycle.isClosing) {
							setError(
								caught instanceof Error ? caught.message : String(caught),
							);
						}
					}
				})();
				appLifecycle.track(memoryTask);
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
	const pendingToolApproval =
		agentState?.toolPermissionContext.pendingToolApproval;

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

			{pendingToolApproval ? (
				<Box
					borderStyle="round"
					borderColor="yellow"
					flexDirection="column"
					paddingX={1}
				>
					<Text color="yellow">tool approval</Text>
					{pendingToolApproval.calls.map((call) => {
						const request = pendingToolApproval.requests.find(
							(candidate) =>
								candidate.callId === call.id &&
								candidate.toolName === call.name,
						);
						return (
							<Box flexDirection="column" key={call.id}>
								<Text color="cyan">{call.name}</Text>
								<Text>{formatApprovalArguments(call.arguments)}</Text>
								<Text color="gray">
									{request?.reason ??
										"This call is included because the entire batch is paused."}
								</Text>
							</Box>
						);
					})}
					<Text color="gray">
						Type "allow" for this batch, "always" for these tools during this
						process session, or "deny". Static path boundaries still apply.
					</Text>
				</Box>
			) : null}

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
							pendingToolApproval
								? "allow, always, or deny..."
								: pendingPlanApproval
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

function parseToolApprovalInput(
	value: string,
): ToolApprovalDecision | undefined {
	const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
	if (["allow", "allow once", "once", "yes", "y"].includes(normalized)) {
		return "allow_once";
	}
	if (
		["always", "allow always", "always allow", "allow session"].includes(
			normalized,
		)
	) {
		return "allow_session";
	}
	if (["deny", "no", "n"].includes(normalized)) {
		return "deny";
	}
	return undefined;
}

function formatApprovalArguments(argumentsText: string): string {
	let value = argumentsText;
	try {
		value = JSON.stringify(JSON.parse(argumentsText), null, 2) ?? argumentsText;
	} catch {
		// Invalid JSON is still shown verbatim and will fail schema validation.
	}
	return value.replace(
		/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
		(character) =>
			`\\u${character.codePointAt(0)?.toString(16).padStart(4, "0")}`,
	);
}
