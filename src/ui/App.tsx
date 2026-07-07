import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useState } from "react";
import type { ModelClient } from "../model/client";
import { query } from "../query";
import { type AgentState, continueState, createInitialState } from "../state";
import { BUILTIN_TOOLS } from "../tools";
import { toToolSpecs } from "../tools/types";
import { Markdown } from "./Markdown";

export type AppProps = {
	task?: string;
	cwd: string;
	model: ModelClient;
};

type Turn = {
	id: string;
	user: string;
	assistant: string;
};

export function App({ task, cwd, model }: AppProps) {
	const [modelName, setModelName] = useState<string | undefined>();
	const [agentState, setAgentState] = useState<AgentState | undefined>();
	const [history, setHistory] = useState<Turn[]>([]);
	const [streamingText, setStreamingText] = useState("");
	const [status, setStatus] = useState<"idle" | "running">("idle");
	const [input, setInput] = useState("");
	const [error, setError] = useState<string | undefined>();

	const runTurn = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (!trimmed || status === "running") {
				return;
			}

			setStatus("running");
			setStreamingText("");
			setError(undefined);

			const initialState = agentState
				? continueState(agentState, trimmed)
				: createInitialState(trimmed, cwd, toToolSpecs(BUILTIN_TOOLS));

			let assistantText = "";

			void (async () => {
				try {
					for await (const event of query({
						initialState,
						model,
						tools: BUILTIN_TOOLS,
					})) {
						if (event.type === "request_start") {
							setModelName(event.model);
						} else if (event.type === "stream_delta") {
							assistantText += event.content;
							setStreamingText(assistantText);
						} else if (event.type === "terminal") {
							setAgentState(event.terminal.state);
							setHistory((current) => [
								...current,
								{
									id: String(event.terminal.state.turn),
									user: trimmed,
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
		[agentState, cwd, model, status],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs once on mount, not on every task/runTurn change
	useEffect(() => {
		if (task) {
			runTurn(task);
		}
	}, []);

	const handleSubmit = (value: string) => {
		setInput("");
		runTurn(value);
	};

	return (
		<Box flexDirection="column" gap={1}>
			<Box flexDirection="column">
				<Text color="cyan">cagent</Text>
				<Text color="gray">cwd: {cwd}</Text>
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

			{status === "idle" ? (
				<Box borderStyle="round" borderColor="cyan" paddingX={1}>
					<Text color="green">{"> "}</Text>
					<TextInput
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
