import { Box, Text, useInput } from "ink";
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
	type ApprovalMode,
	continueState,
	createInitialState,
	enterPlanMode,
	type Message,
	resolvePlanApproval,
	resolveToolApproval,
	setApprovalMode as setStateApprovalMode,
	type ToolApprovalDecision,
	type ToolFailure,
} from "../state";
import { BUILTIN_TOOLS } from "../tools";
import { type Tools, toToolSpecs } from "../tools/types";
import { type AppLifecycle, createAppLifecycle } from "./appLifecycle";
import { parseLocalCommand } from "./localCommands";
import { Markdown } from "./Markdown";
import { SelectionMenu, type SelectionMenuOption } from "./SelectionMenu";

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

const PERMISSION_OPTIONS: Array<{
	mode: ApprovalMode;
	label: string;
	description: string;
}> = [
	{
		mode: "ask",
		label: "Ask for approval",
		description: "Ask before workspace edits, Shell, or external MCP calls",
	},
	{
		mode: "auto",
		label: "Approve for me",
		description:
			"Automatically allow bounded workspace edits; ask for Shell and MCP calls",
	},
	{
		mode: "full_access",
		label: "Full access",
		description:
			"Run without approval, filesystem sandboxing, or network restrictions",
	},
];

const TOOL_APPROVAL_OPTIONS: readonly SelectionMenuOption<ToolApprovalDecision>[] =
	[
		{
			value: "allow_once",
			label: "Yes, proceed",
			description: "Allow only this paused tool batch.",
		},
		{
			value: "allow_session",
			label: "Yes, and don't ask again for these tools in this session",
			description:
				"Remember the tool names for this process session; static path boundaries still apply.",
		},
		{
			value: "deny",
			label: "No, reject this request",
			description: "Return a denial to the agent without running the batch.",
			tone: "danger",
		},
	];

type PlanApprovalChoice = "approve" | "reject";

const PLAN_APPROVAL_OPTIONS: readonly SelectionMenuOption<PlanApprovalChoice>[] =
	[
		{
			value: "approve",
			label: "Yes, implement this plan",
			description: "Leave plan mode and continue with implementation.",
		},
		{
			value: "reject",
			label: "No, keep planning",
			description: "Optionally tell cagent what should change first.",
			tone: "danger",
		},
	];

type TimelineEntry =
	| {
			id: string;
			kind: "message";
			role: "user" | "assistant" | "agent";
			content: string;
	  }
	| {
			id: string;
			kind: "tool_call";
			callId: string;
			name: string;
			arguments: string;
	  }
	| {
			id: string;
			kind: "tool_result";
			callId: string;
			name: string;
			status: "succeeded" | "failed";
			content: string;
			failure?: ToolFailure;
	  }
	| {
			id: string;
			kind: "approval";
			content: string;
	  }
	| {
			id: string;
			kind: "local";
			command: string;
			content: string;
	  };

type RunSource =
	| { kind: "user"; content: string }
	| { kind: "approval"; content: string }
	| { kind: "background" };

function timelineFromState(state: AgentState | undefined): TimelineEntry[] {
	if (!state) {
		return [];
	}

	const entries: TimelineEntry[] = [];
	const toolNames = new Map<string, string>();
	for (const [messageIndex, message] of state.messages.entries()) {
		entries.push(
			...timelineEntriesForMessage(
				message,
				toolNames,
				`${state.sessionId}:${messageIndex}`,
			),
		);
	}
	return entries;
}

function timelineEntriesForMessage(
	message: Message,
	toolNames: Map<string, string>,
	idPrefix: string,
): TimelineEntry[] {
	const timelineMessage = message;
	if (timelineMessage.origin === "approval") {
		return timelineMessage.content.trim()
			? [
					{
						id: `${idPrefix}:approval`,
						kind: "approval",
						content: timelineMessage.content,
					},
				]
			: [];
	}

	if (timelineMessage.role === "assistant") {
		const entries: TimelineEntry[] = [];
		if (timelineMessage.content.trim()) {
			entries.push({
				id: `${idPrefix}:assistant`,
				kind: "message",
				role: "assistant",
				content: timelineMessage.content,
			});
		}
		for (const [callIndex, call] of (
			timelineMessage.toolCalls ?? []
		).entries()) {
			toolNames.set(call.id, call.name);
			entries.push({
				id: `${idPrefix}:tool-call:${callIndex}:${call.id}`,
				kind: "tool_call",
				callId: call.id,
				name: call.name,
				arguments: call.arguments,
			});
		}
		return entries;
	}

	if (timelineMessage.role === "tool") {
		const callId = timelineMessage.toolCallId ?? "unknown";
		const status =
			timelineMessage.toolResult?.status ??
			(timelineMessage.content.startsWith("error:") ? "failed" : "succeeded");
		return [
			{
				id: `${idPrefix}:tool-result:${callId}`,
				kind: "tool_result",
				callId,
				name: toolNames.get(callId) ?? "Unknown tool",
				status,
				content: timelineMessage.content,
				failure: timelineMessage.toolResult?.failure,
			},
		];
	}

	if (
		(timelineMessage.role === "user" || timelineMessage.role === "agent") &&
		timelineMessage.content.trim()
	) {
		return [
			{
				id: `${idPrefix}:${timelineMessage.role}`,
				kind: "message",
				role: timelineMessage.role,
				content: timelineMessage.content,
			},
		];
	}

	return [];
}

function appendMessageToTimeline(
	current: TimelineEntry[],
	message: Message,
	sessionId: string,
): TimelineEntry[] {
	const toolNames = new Map(
		current
			.filter(
				(entry): entry is Extract<TimelineEntry, { kind: "tool_call" }> =>
					entry.kind === "tool_call",
			)
			.map((entry) => [entry.callId, entry.name]),
	);
	return [
		...current,
		...timelineEntriesForMessage(
			message,
			toolNames,
			`${sessionId}:live:${current.length}`,
		),
	];
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
	if (entry.kind === "message") {
		const color =
			entry.role === "user"
				? "green"
				: entry.role === "assistant"
					? "blue"
					: "magenta";
		return (
			<Box flexDirection="column">
				<Text color={color}>{entry.role}</Text>
				{entry.role === "user" ? (
					<Text>{entry.content}</Text>
				) : (
					<Markdown>{entry.content}</Markdown>
				)}
			</Box>
		);
	}

	if (entry.kind === "tool_call") {
		return (
			<Box flexDirection="column">
				<Text>
					<Text color="cyan">tool request</Text> <Text bold>{entry.name}</Text>
				</Text>
				<Text color="gray">{formatApprovalArguments(entry.arguments)}</Text>
			</Box>
		);
	}

	if (entry.kind === "tool_result") {
		const failed = entry.status === "failed";
		return (
			<Box flexDirection="column">
				<Text>
					<Text color={failed ? "red" : "green"}>
						tool result · {entry.status}
					</Text>{" "}
					<Text bold>{entry.name}</Text>
				</Text>
				{entry.failure ? (
					<Box flexDirection="column">
						<Text color="red">
							{entry.failure.kind}
							{entry.failure.stage ? ` · ${entry.failure.stage}` : ""}
							{entry.failure.exitCode === undefined
								? ""
								: ` · exit ${entry.failure.exitCode}`}
						</Text>
						<Text color="red">{formatTimelineValue(entry.content)}</Text>
					</Box>
				) : (
					<Text color={failed ? "red" : undefined}>
						{formatTimelineValue(entry.content)}
					</Text>
				)}
			</Box>
		);
	}

	if (entry.kind === "approval") {
		return (
			<Box flexDirection="column">
				<Text color="yellow">approval</Text>
				<Text>{entry.content}</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<Text color="cyan">local · {entry.command}</Text>
			<Markdown>{entry.content}</Markdown>
		</Box>
	);
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
	const [history, setHistory] = useState<TimelineEntry[]>(
		timelineFromState(restoredState),
	);
	const [streamingText, setStreamingText] = useState("");
	const [status, setStatus] = useState<"idle" | "running">("idle");
	const runInFlightRef = useRef(false);
	const [input, setInput] = useState("");
	const [error, setError] = useState<string | undefined>();
	const [agentInboxRevision, setAgentInboxRevision] = useState(0);
	const [approvalMode, setApprovalMode] = useState<ApprovalMode>("ask");
	const [permissionsOpen, setPermissionsOpen] = useState(false);
	const [permissionSelection, setPermissionSelection] = useState(0);
	const [permissionChangeInFlight, setPermissionChangeInFlight] =
		useState(false);
	const permissionChangeInFlightRef = useRef(false);
	const [toolApprovalSelection, setToolApprovalSelection] = useState(0);
	const [planApprovalSelection, setPlanApprovalSelection] = useState(0);
	const [planFeedbackOpen, setPlanFeedbackOpen] = useState(false);
	const [planFeedback, setPlanFeedback] = useState("");
	const pendingPlanApproval =
		agentState?.toolPermissionContext.pendingPlanApproval;
	const pendingToolApproval =
		agentState?.toolPermissionContext.pendingToolApproval;

	const applyApprovalMode = useCallback(
		(mode: ApprovalMode) => {
			if (permissionChangeInFlightRef.current) {
				return;
			}
			const option = PERMISSION_OPTIONS.find(
				(candidate) => candidate.mode === mode,
			);
			const currentMode =
				agentState?.toolPermissionContext.approvalMode ?? approvalMode;
			const recordChange = () =>
				setHistory((current) => [
					...current,
					{
						id: `local-permissions-${current.length + 1}`,
						kind: "local",
						command: "/permissions",
						content: `${option?.label ?? mode}\n\n${option?.description ?? ""}`,
					},
				]);

			setPermissionsOpen(false);
			setError(undefined);
			if (currentMode === mode) {
				recordChange();
				return;
			}

			permissionChangeInFlightRef.current = true;
			setPermissionChangeInFlight(true);
			const permissionTask = (async () => {
				try {
					if (agentState) {
						await agentRuntime.quiesceForPermissionChange(
							agentState,
							`permission policy changed from ${currentMode} to ${mode}`,
						);
					}
					if (appLifecycle.isClosing) {
						return;
					}
					setApprovalMode(mode);
					setAgentState((current) =>
						current ? setStateApprovalMode(current, mode) : current,
					);
					recordChange();
				} catch (caught) {
					if (!appLifecycle.isClosing) {
						setError(`permission change failed: ${formatCaught(caught)}`);
					}
				} finally {
					permissionChangeInFlightRef.current = false;
					if (!appLifecycle.isClosing) {
						setPermissionChangeInFlight(false);
					}
				}
			})();
			appLifecycle.track(permissionTask);
		},
		[agentRuntime, agentState, appLifecycle, approvalMode],
	);

	const runState = useCallback(
		(
			initialState: AgentState,
			persistFromMessageIndex: number,
			source: RunSource,
		) => {
			if (
				runInFlightRef.current ||
				permissionChangeInFlightRef.current ||
				appLifecycle.isClosing
			) {
				return;
			}

			runInFlightRef.current = true;
			setStatus("running");
			setStreamingText("");
			setError(undefined);
			setAgentState(initialState);
			if (source.kind !== "background") {
				setHistory((current) => {
					const id = `${initialState.sessionId}:source:${current.length}`;
					const entry: TimelineEntry =
						source.kind === "user"
							? {
									id,
									kind: "message",
									role: "user",
									content: source.content,
								}
							: { id, kind: "approval", content: source.content };
					return [...current, entry];
				});
			}

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
							if (!appLifecycle.isClosing) {
								setHistory((current) =>
									appendMessageToTimeline(
										current,
										event.message,
										initialState.sessionId,
									),
								);
								if (event.message.role === "assistant") {
									assistantText = "";
									setStreamingText("");
								}
							}
						} else if (event.type === "state") {
							latestState = event.state;
							await appendSessionState(cwd, event.state);
							statePersisted = true;
							if (!appLifecycle.isClosing) {
								setAgentState(event.state);
							}
						} else if (event.type === "compaction") {
							latestState = event.state;
							await appendSessionCompaction(cwd, event.state);
							if (!appLifecycle.isClosing) {
								setAgentState(event.state);
							}
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

			const baseState = agentState
				? continueState(agentState, trimmed)
				: createInitialState(trimmed, cwd, toToolSpecs(tools));
			const initialState = setStateApprovalMode(baseState, approvalMode);

			runState(initialState, agentState?.messages.length ?? 0, {
				kind: "user",
				content: trimmed,
			});
		},
		[agentState, appLifecycle, approvalMode, cwd, runState, status, tools],
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
			permissionChangeInFlight ||
			!agentState ||
			agentState.toolPermissionContext.pendingPlanApproval ||
			agentState.toolPermissionContext.pendingToolApproval ||
			agentState.transition?.reason === "max_turns" ||
			agentState.budget.turnsUsed >= agentState.budget.maxTurns ||
			!agentRuntime.hasPendingMessages(agentState.agent.id)
		) {
			return;
		}
		runState(agentState, agentState.messages.length, { kind: "background" });
	}, [
		agentInboxRevision,
		agentRuntime,
		agentState,
		permissionChangeInFlight,
		runState,
		status,
	]);

	useEffect(() => {
		if (
			status !== "idle" ||
			!agentState?.toolPermissionContext.pendingToolApproval?.needsRevalidation
		) {
			return;
		}
		runState(agentState, agentState.messages.length, { kind: "background" });
	}, [agentState, runState, status]);

	useEffect(() => {
		if (pendingPlanApproval || pendingToolApproval) {
			setPermissionsOpen(false);
		}
		if (!pendingPlanApproval) {
			setPlanFeedbackOpen(false);
			setPlanFeedback("");
		}
	}, [pendingPlanApproval, pendingToolApproval]);

	const submitToolApproval = useCallback(
		(decision: ToolApprovalDecision) => {
			if (
				appLifecycle.isClosing ||
				runInFlightRef.current ||
				!agentState ||
				!pendingToolApproval
			) {
				return;
			}
			if (pendingToolApproval.needsRevalidation) {
				setError(
					"Refreshing restored tool approval details; try again shortly.",
				);
				return;
			}

			setError(undefined);
			setToolApprovalSelection(0);
			const nextState = resolveToolApproval(agentState, decision);
			const approvalLabel =
				decision === "allow_once"
					? "Tool calls allowed once"
					: decision === "allow_session"
						? "Tool calls allowed for this session"
						: "Tool calls denied";
			runState(nextState, agentState.messages.length, {
				kind: "approval",
				content: approvalLabel,
			});
		},
		[agentState, appLifecycle, pendingToolApproval, runState],
	);

	const submitPlanApproval = useCallback(
		(decision: PlanApprovalChoice, feedback = "") => {
			if (
				appLifecycle.isClosing ||
				runInFlightRef.current ||
				!agentState ||
				!pendingPlanApproval
			) {
				return;
			}

			const normalizedFeedback = feedback.trim();
			setError(undefined);
			setPlanApprovalSelection(0);
			setPlanFeedbackOpen(false);
			setPlanFeedback("");
			const nextState = resolvePlanApproval(
				agentState,
				decision,
				normalizedFeedback,
			);
			runState(nextState, agentState.messages.length, {
				kind: "approval",
				content:
					decision === "approve"
						? "Plan approved"
						: `Plan rejected${normalizedFeedback ? `: ${normalizedFeedback}` : ""}`,
			});
		},
		[agentState, appLifecycle, pendingPlanApproval, runState],
	);

	const choosePlanApproval = useCallback(
		(decision: PlanApprovalChoice) => {
			if (decision === "approve") {
				submitPlanApproval("approve");
				return;
			}
			setError(undefined);
			setPlanFeedback("");
			setPlanFeedbackOpen(true);
		},
		[submitPlanApproval],
	);

	useInput(
		(_input, key) => {
			if (key.escape) {
				setPlanFeedbackOpen(false);
				setPlanFeedback("");
				setError(undefined);
			}
		},
		{
			isActive:
				status === "idle" && Boolean(pendingPlanApproval) && planFeedbackOpen,
		},
	);

	const handleSubmit = (value: string) => {
		if (appLifecycle.isClosing) {
			return;
		}
		setInput("");
		if (pendingToolApproval || pendingPlanApproval) {
			setError("Resolve the pending approval with the selection menu.");
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
							setApprovalMode("ask");
							setAgentState(restored);
							setHistory(timelineFromState(restored));
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

			if (localCommand.type === "open_permissions") {
				const currentIndex = PERMISSION_OPTIONS.findIndex(
					(option) => option.mode === approvalMode,
				);
				setPermissionSelection(Math.max(0, currentIndex));
				setPermissionsOpen(true);
				setError(undefined);
				return;
			}

			if (localCommand.type === "set_permissions") {
				applyApprovalMode(localCommand.mode);
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
									kind: "local",
									command: "/memory",
									content: formatMemoryStoreSummary(info),
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
				const nextState = setStateApprovalMode(
					enterPlanMode(
						agentState ?? createInitialState("/plan", cwd, toToolSpecs(tools)),
					),
					approvalMode,
				);
				setAgentState(nextState);
				setHistory((current) => [
					...current,
					{
						id: `local-${current.length + 1}`,
						kind: "local",
						command: "/plan",
						content:
							"Entered plan mode.\n\nThe plan is stored as runtime state only.",
					},
				]);
				setError(undefined);
			}
			return;
		}

		runTurn(value);
	};

	return (
		<Box flexDirection="column" gap={1}>
			<Box flexDirection="column">
				<Text color="cyan">cagent</Text>
				<Text color="gray">cwd: {cwd}</Text>
				<Text color="gray">permissions: {approvalMode}</Text>
				{agentState ? (
					<Text color="gray">session: {agentState.sessionId}</Text>
				) : null}
				{modelName ? <Text color="gray">model: {modelName}</Text> : null}
			</Box>

			{history.map((entry) => (
				<TimelineRow entry={entry} key={entry.id} />
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
					<Text bold>Would you like to run these tool calls?</Text>
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
					{pendingToolApproval.needsRevalidation ? (
						<Text color="yellow">
							Refreshing restored approval details before accepting a
							decision...
						</Text>
					) : (
						<SelectionMenu
							isActive={status === "idle" && !permissionChangeInFlight}
							onCancel={() => submitToolApproval("deny")}
							onConfirm={submitToolApproval}
							onSelectionChange={setToolApprovalSelection}
							options={TOOL_APPROVAL_OPTIONS}
							selectedIndex={toolApprovalSelection}
						/>
					)}
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
					{planFeedbackOpen ? (
						<Box flexDirection="column" marginTop={1}>
							<Text bold>What should cagent change before asking again?</Text>
							<Box borderStyle="round" borderColor="cyan" paddingX={1}>
								<Text color="green">{"> "}</Text>
								<TextInput
									focus={status === "idle"}
									onChange={setPlanFeedback}
									onSubmit={(feedback) =>
										submitPlanApproval("reject", feedback)
									}
									placeholder="Describe the changes (optional)..."
									value={planFeedback}
								/>
							</Box>
							<Text color="gray">
								Press Enter to send feedback, or Esc to return to the choices.
							</Text>
						</Box>
					) : (
						<SelectionMenu
							isActive={status === "idle" && !permissionChangeInFlight}
							onCancel={() => submitPlanApproval("reject")}
							onConfirm={choosePlanApproval}
							onSelectionChange={setPlanApprovalSelection}
							options={PLAN_APPROVAL_OPTIONS}
							selectedIndex={planApprovalSelection}
						/>
					)}
				</Box>
			) : null}

			{permissionChangeInFlight ? (
				<Text color="yellow">
					Stopping active sub-agents before changing permissions...
				</Text>
			) : null}

			{status === "idle" && !permissionChangeInFlight && permissionsOpen ? (
				<Box
					borderStyle="round"
					borderColor="yellow"
					flexDirection="column"
					paddingX={1}
				>
					<Text color="yellow">How should cagent actions be approved?</Text>
					<SelectionMenu
						footer="Use ↑/↓ and Enter, press 1-3, or Esc to cancel. Full access gives the agent your host-user authority."
						onCancel={() => setPermissionsOpen(false)}
						onConfirm={applyApprovalMode}
						onSelectionChange={setPermissionSelection}
						options={PERMISSION_OPTIONS.map((option) => ({
							value: option.mode,
							label: `${option.label}${approvalMode === option.mode ? " (current)" : ""}`,
							description: option.description,
							tone: option.mode === "full_access" ? "danger" : "default",
						}))}
						selectedIndex={permissionSelection}
					/>
				</Box>
			) : status === "idle" &&
				!permissionChangeInFlight &&
				!pendingToolApproval &&
				!pendingPlanApproval ? (
				<Box borderStyle="round" borderColor="cyan" paddingX={1}>
					<Text color="green">{"> "}</Text>
					<TextInput
						focus
						value={input}
						onChange={setInput}
						onSubmit={handleSubmit}
						placeholder="Type a message and press Enter..."
					/>
				</Box>
			) : null}
		</Box>
	);
}

function formatCaught(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}

function formatApprovalArguments(argumentsText: string): string {
	return formatTimelineValue(argumentsText);
}

function formatTimelineValue(text: string): string {
	let value = text;
	try {
		value = JSON.stringify(JSON.parse(text), null, 2) ?? text;
	} catch {
		// Commands and error output are often plain text; show them verbatim.
	}
	return Array.from(value.replace(/\r\n/g, "\n"), (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return isUnsafeTimelineCodePoint(codePoint)
			? `\\u${codePoint.toString(16).padStart(4, "0")}`
			: character;
	}).join("");
}

function isUnsafeTimelineCodePoint(codePoint: number): boolean {
	return (
		codePoint <= 0x09 ||
		(codePoint >= 0x0b && codePoint <= 0x1f) ||
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		codePoint === 0x061c ||
		codePoint === 0x200e ||
		codePoint === 0x200f ||
		(codePoint >= 0x202a && codePoint <= 0x202e) ||
		(codePoint >= 0x2066 && codePoint <= 0x2069)
	);
}
