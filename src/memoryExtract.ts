import { readFile } from "node:fs/promises";
import {
	ensureMemoryStore,
	formatMemoryManifest,
	MEMORY_ENTRYPOINT_NAME,
	refreshMemoryIndex,
	validateMemoryStore,
} from "./memory";
import type { ModelClient } from "./model/client";
import { query } from "./query";
import {
	type AgentState,
	createInitialState,
	createToolPermissionContext,
	type Message,
} from "./state";
import { editTool, globTool, grepTool, readTool, writeTool } from "./tools";
import type { Tools } from "./tools/types";
import { toToolSpecs } from "./tools/types";

const MEMORY_EXTRACTION_MAX_TURNS = 8;

const MEMORY_EXTRACTION_TOOLS: Tools = [
	readTool,
	globTool,
	grepTool,
	writeTool,
	editTool,
];

export type MemoryExtractionResult = {
	subAgentSessionId: string;
	ok: boolean;
	summary: string;
};

export async function runMemoryExtractionSubAgent(params: {
	state: AgentState;
	model: ModelClient;
}): Promise<MemoryExtractionResult> {
	const { state, model } = params;
	const subAgentSessionId = `${state.sessionId}.memory.${state.turn}`;

	let finalAnswer = "";
	try {
		const memoryStore = await ensureMemoryStore(state.cwd);
		const existingMemoryContext = await buildExistingMemoryContext(memoryStore);
		const task = buildMemoryExtractionTask(
			state,
			memoryStore.memoryDir,
			existingMemoryContext,
		);
		const initialState: AgentState = {
			...createInitialState(
				task,
				state.cwd,
				toToolSpecs(MEMORY_EXTRACTION_TOOLS),
				subAgentSessionId,
			),
			toolPermissionContext: createToolPermissionContext(state.cwd, {
				agentType: "memory",
			}),
			maxTurns: MEMORY_EXTRACTION_MAX_TURNS,
			budget: {
				turnsUsed: 0,
				maxTurns: MEMORY_EXTRACTION_MAX_TURNS,
			},
		};

		for await (const event of query({
			initialState,
			model,
			tools: MEMORY_EXTRACTION_TOOLS,
			enableMemoryExtraction: false,
		})) {
			if (event.type === "terminal") {
				finalAnswer = event.terminal.state.finalAnswer ?? "";
			}
		}
		await refreshMemoryIndex(state.cwd);
		const validationIssues = await validateMemoryStore(state.cwd);
		if (validationIssues.length > 0) {
			return {
				subAgentSessionId,
				ok: false,
				summary: formatValidationSummary(validationIssues),
			};
		}
		return {
			subAgentSessionId,
			ok: true,
			summary: finalAnswer.trim() || "memory extraction completed",
		};
	} catch (caught) {
		return {
			subAgentSessionId,
			ok: false,
			summary: caught instanceof Error ? caught.message : String(caught),
		};
	}
}

export function shouldRequestMemoryExtraction(state: AgentState): boolean {
	if (state.toolPermissionContext.mode !== "normal") {
		return false;
	}

	const latest = latestUserAssistantPair(state.messages);
	if (!latest) {
		return false;
	}

	const userText = latest.user.content.toLowerCase();
	return !(
		userText.includes("don't remember") ||
		userText.includes("do not remember") ||
		userText.includes("不要记") ||
		userText.includes("别记")
	);
}

function buildMemoryExtractionTask(
	state: AgentState,
	memoryDir: string,
	existingMemoryContext: string,
): string {
	const latest = latestUserAssistantPair(state.messages);
	const transcript = latest
		? `User:\n${latest.user.content}\n\nAssistant:\n${latest.assistant.content}`
		: "No complete user/assistant exchange is available.";

	return [
		"You are a background cagent memory extraction sub-agent.",
		"",
		`Memory directory: ${memoryDir}`,
		"",
		"Existing memory state, read before deciding whether to create a new file:",
		existingMemoryContext,
		"",
		"Review the transcript below and decide whether it contains stable cross-session memory worth saving.",
		"Only save user preferences, feedback about how to work with the user, project context not obvious from the repo, or external reference locations.",
		"Do not save ephemeral task state, raw summaries, TODOs, git history, or code facts that can be derived from current files.",
		"",
		"If there is nothing worth saving, do not call tools and answer exactly: NO_MEMORY.",
		"If there is memory worth saving, update an existing topic file when the topic already exists; only create a new focused markdown file for genuinely new stable memory.",
		"Every topic file must use the cagent memory frontmatter schema with type, description, created_at, updated_at, source, confidence, stability, and optional ttl.",
		"Do not edit MEMORY.md directly; it is regenerated automatically after extraction.",
		"Use ISO-8601 timestamps. Prefer stability=evolving for preferences or project facts that may change.",
		"After writing, answer with a one-line summary of what memory changed.",
		"",
		"Transcript:",
		"```",
		transcript,
		"```",
	].join("\n");
}

async function buildExistingMemoryContext(
	memoryStore: Awaited<ReturnType<typeof ensureMemoryStore>>,
): Promise<string> {
	const topicFiles = memoryStore.files.filter(
		(file) => file.filename !== MEMORY_ENTRYPOINT_NAME,
	);
	const index = await readFile(memoryStore.indexPath, "utf-8").catch(() => "");
	const manifest = formatMemoryManifest(topicFiles);
	return [
		`Current ${MEMORY_ENTRYPOINT_NAME}:`,
		"```markdown",
		index.trim() || "# Memory",
		"```",
		"",
		"Existing topic manifest:",
		manifest || "No existing memory topic files.",
	].join("\n");
}

function formatValidationSummary(
	issues: { path: string; message: string }[],
): string {
	const details = issues
		.slice(0, 5)
		.map((issue) => `${issue.path}: ${issue.message}`)
		.join("; ");
	const suffix = issues.length > 5 ? `; +${issues.length - 5} more` : "";
	return `memory validation failed: ${details}${suffix}`;
}

function latestUserAssistantPair(
	messages: Message[],
): { user: Message; assistant: Message } | undefined {
	let assistant: Message | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message) {
			continue;
		}
		if (!assistant && message.role === "assistant" && message.content.trim()) {
			assistant = message;
			continue;
		}
		if (assistant && message.role === "user") {
			return { user: message, assistant };
		}
	}
	return undefined;
}
