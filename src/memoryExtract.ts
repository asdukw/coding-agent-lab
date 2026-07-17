import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
	ensureMemoryStore,
	formatMemoryManifest,
	isMemoryIndexPath,
	MAX_MEMORY_TOPIC_BYTES,
	MEMORY_ENTRYPOINT_NAME,
	refreshMemoryIndex,
	validateMemoryStore,
} from "./memory";
import type { ModelClient } from "./model/client";
import { query, type Terminal } from "./query";
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
const EXISTING_MEMORY_CONTEXT_MAX_FILES = 25;
const EXISTING_MEMORY_CONTEXT_MAX_BYTES = 50_000;
const EXISTING_MEMORY_FILE_MAX_BYTES = 5_000;
const EXISTING_MEMORY_INDEX_MAX_BYTES = 25_000;
const extractionTails = new Map<string, Promise<void>>();

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
	reason?:
		| "preflight_error"
		| "query_error"
		| "max_turns"
		| "model_error"
		| "tool_error"
		| "index_error"
		| "validation_error";
	reasons?: Array<NonNullable<MemoryExtractionResult["reason"]>>;
};

export async function runMemoryExtractionSubAgent(params: {
	state: AgentState;
	model: ModelClient;
	signal?: AbortSignal;
}): Promise<MemoryExtractionResult> {
	const resolvedCwd = resolve(params.state.cwd);
	const canonicalCwd = await realpath(resolvedCwd).catch(() => resolvedCwd);
	const key =
		process.platform === "win32" ? canonicalCwd.toLowerCase() : canonicalCwd;
	const previous = extractionTails.get(key) ?? Promise.resolve();
	let release: () => void = () => undefined;
	const current = new Promise<void>((resolveCurrent) => {
		release = resolveCurrent;
	});
	const tail = previous.catch(() => undefined).then(() => current);
	extractionTails.set(key, tail);

	await previous.catch(() => undefined);
	try {
		params.signal?.throwIfAborted();
		return await executeMemoryExtraction(params);
	} finally {
		release();
		if (extractionTails.get(key) === tail) {
			extractionTails.delete(key);
		}
	}
}

async function executeMemoryExtraction(params: {
	state: AgentState;
	model: ModelClient;
	signal?: AbortSignal;
}): Promise<MemoryExtractionResult> {
	const { state, model, signal } = params;
	const subAgentSessionId = `${state.sessionId}.memory.${state.turn}`;

	let finalAnswer = "";
	let terminal: Terminal | undefined;
	let queryError: unknown;
	let queryPhase: "preflight" | "model" = "preflight";
	let baselineValidationIssues: { path: string; message: string }[] = [];
	const streamedToolErrors: string[] = [];
	try {
		signal?.throwIfAborted();
		const memoryStore = await ensureMemoryStore(state.cwd);
		const existingMemoryContext = await buildExistingMemoryContext(memoryStore);
		baselineValidationIssues = await validateMemoryStore(state.cwd);
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
			agent: {
				id: subAgentSessionId,
				parentId: state.agent.id,
				type: "memory",
				depth: state.agent.depth + 1,
			},
			toolPermissionContext: createToolPermissionContext(state.cwd, {
				agentType: "memory",
			}),
			maxTurns: MEMORY_EXTRACTION_MAX_TURNS,
			budget: {
				turnsUsed: 0,
				maxTurns: MEMORY_EXTRACTION_MAX_TURNS,
			},
		};

		queryPhase = "model";
		for await (const event of query({
			initialState,
			model,
			tools: MEMORY_EXTRACTION_TOOLS,
			enableMemoryExtraction: false,
			signal,
		})) {
			if (event.type === "terminal") {
				terminal = event.terminal;
				finalAnswer = event.terminal.state.finalAnswer ?? "";
			} else if (
				event.type === "message" &&
				event.message.role === "tool" &&
				event.message.content.startsWith("error:")
			) {
				streamedToolErrors.push(event.message.content);
			}
		}
	} catch (caught) {
		queryError = caught;
	}

	let indexError: unknown;
	try {
		await refreshMemoryIndex(state.cwd);
	} catch (caught) {
		indexError = caught;
	}

	let validationIssues: { path: string; message: string }[] = [];
	let validationError: unknown;
	try {
		validationIssues = await validateMemoryStore(state.cwd);
	} catch (caught) {
		validationError = caught;
	}
	const baselineIssueKeys = new Set(
		baselineValidationIssues.map(memoryIssueKey),
	);
	const newValidationIssues = validationIssues.filter(
		(issue) => !baselineIssueKeys.has(memoryIssueKey(issue)),
	);

	const failedObservations = terminal?.state.observations.filter(
		(observation) => !observation.ok,
	);
	const toolErrors = [
		...(failedObservations?.map((observation) => observation.output) ?? []),
		...streamedToolErrors,
	].filter((message, index, all) => all.indexOf(message) === index);
	const failures: {
		reason: NonNullable<MemoryExtractionResult["reason"]>;
		summary: string;
	}[] = [];
	if (queryError) {
		failures.push({
			reason: queryPhase === "preflight" ? "preflight_error" : "model_error",
			summary: `memory ${queryPhase} failed: ${formatCaught(queryError)}`,
		});
	} else if (!terminal) {
		failures.push({
			reason: "query_error",
			summary: "memory query ended without a terminal result",
		});
	} else if (terminal.reason !== "complete") {
		failures.push({
			reason: terminal.reason === "max_turns" ? "max_turns" : "model_error",
			summary: `memory query ended with ${terminal.reason}`,
		});
	}
	if (toolErrors.length > 0) {
		failures.push({
			reason: "tool_error",
			summary: `memory tool failure: ${toolErrors.slice(0, 3).join("; ")}`,
		});
	}
	if (indexError) {
		failures.push({
			reason: "index_error",
			summary: `memory index refresh failed: ${formatCaught(indexError)}`,
		});
	}
	if (validationError) {
		failures.push({
			reason: "validation_error",
			summary: `memory validation failed to run: ${formatCaught(validationError)}`,
		});
	} else if (newValidationIssues.length > 0) {
		failures.push({
			reason: "validation_error",
			summary: formatValidationSummary(newValidationIssues),
		});
	}

	if (failures.length > 0) {
		const reasons = failures
			.map((failure) => failure.reason)
			.filter((reason, index, all) => all.indexOf(reason) === index);
		return {
			subAgentSessionId,
			ok: false,
			reason: reasons[0],
			reasons,
			summary: failures.map((failure) => failure.summary).join(" | "),
		};
	}

	return {
		subAgentSessionId,
		ok: true,
		summary: finalAnswer.trim() || "memory extraction completed",
	};
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
		"Before creating a file, inspect the existing manifest and content excerpts below. Read any plausible matching topic file in full, then update it instead of creating a semantic duplicate.",
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
		(file) => !isMemoryIndexPath(file.filename),
	);
	const index = await readTextPrefix(
		memoryStore.indexPath,
		EXISTING_MEMORY_INDEX_MAX_BYTES,
	);
	const manifest = formatMemoryManifest(topicFiles);
	const contents = await readExistingMemoryContents(topicFiles);
	return [
		`Current ${MEMORY_ENTRYPOINT_NAME}:`,
		"```markdown",
		index.content.trim() || "# Memory",
		...(index.truncated ? ["[truncated]"] : []),
		"```",
		"",
		"Existing topic manifest:",
		manifest || "No existing memory topic files.",
		"",
		"Existing topic content excerpts:",
		contents || "No existing memory topic files.",
	].join("\n");
}

async function readExistingMemoryContents(
	topicFiles: Awaited<ReturnType<typeof ensureMemoryStore>>["files"],
): Promise<string> {
	const sections: string[] = [];
	let totalBytes = 0;
	for (const memory of topicFiles.slice(0, EXISTING_MEMORY_CONTEXT_MAX_FILES)) {
		if (memory.readFailure) {
			throw new Error(
				`Cannot read existing memory ${memory.filename}: ${memory.readFailure}`,
			);
		}
		if (memory.sizeBytes > MAX_MEMORY_TOPIC_BYTES) {
			throw new Error(
				`Existing memory ${memory.filename} exceeds ${MAX_MEMORY_TOPIC_BYTES} bytes`,
			);
		}
		const raw = await readTextPrefix(
			memory.filePath,
			EXISTING_MEMORY_FILE_MAX_BYTES,
		);
		const excerpt = raw.truncated ? `${raw.content}\n[truncated]` : raw.content;
		const section = `<memory path="${escapeXmlAttribute(memory.filename)}">\n${excerpt}\n</memory>`;
		const sectionBytes = Buffer.byteLength(section, "utf-8");
		if (totalBytes + sectionBytes > EXISTING_MEMORY_CONTEXT_MAX_BYTES) {
			break;
		}
		sections.push(section);
		totalBytes += sectionBytes;
	}
	if (sections.length < topicFiles.length) {
		sections.push(
			`[${topicFiles.length - sections.length} additional topic files omitted; use Read for plausible matches before creating a file]`,
		);
	}
	return sections.join("\n\n");
}

async function readTextPrefix(
	path: string,
	maxBytes: number,
): Promise<{ content: string; truncated: boolean }> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const truncated = bytesRead > maxBytes;
		const bytes = buffer.subarray(0, Math.min(bytesRead, maxBytes));
		const content = new TextDecoder().decode(bytes, { stream: truncated });
		return { content, truncated };
	} finally {
		await handle.close();
	}
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
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

function formatCaught(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}

function memoryIssueKey(issue: { path: string; message: string }): string {
	return `${issue.path}\u0000${issue.message}`;
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
		if (assistant && message.role === "agent") {
			return undefined;
		}
		if (assistant && message.role === "user") {
			return { user: message, assistant };
		}
	}
	return undefined;
}
