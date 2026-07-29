import type { AgentState, Message } from "../state";
import type {
	Task,
	TaskDraft,
	TaskStatus,
	TaskUpdateOutcome,
	TaskUpdateRequest,
} from "../tasks";
import type { ToolExecution } from "../toolExecutionMemory";
import type { AgentKind } from "./identity";

export const AGENT_COORDINATION_PREFIX = "[agent-coordination:untrusted]\n";

export type AgentStatus =
	| "created"
	| "running"
	| "cancelling"
	| "completing"
	| "completed"
	| "failed"
	| "cancelled";

export type AgentContextMode = "task-only" | "fork";

export type SpawnAgentRequest = {
	task: string;
	description?: string;
	agentType?: Exclude<AgentKind, "main" | "memory">;
	name?: string;
	runInBackground?: boolean;
	contextMode?: AgentContextMode;
	maxTurns?: number;
};

export type AgentResult = {
	agentId: string;
	status: "completed" | "failed" | "cancelled";
	summary: string;
	changedFiles: string[];
	toolExecutions: ToolExecution[];
	turnsUsed: number;
	error?: string;
};

export type AgentMemoryUpdate = {
	toolExecutions: ToolExecution[];
	changedFiles: string[];
};

export type AgentRecord = {
	id: string;
	parentId: string;
	sessionId: string;
	childSessionId: string;
	name?: string;
	description: string;
	task: string;
	agentType: Exclude<AgentKind, "main" | "memory">;
	depth: number;
	background: boolean;
	status: AgentStatus;
	taskId?: string;
	runId?: string;
	createdAt: string;
	startedAt?: string;
	lastHeartbeatAt?: string;
	completedAt?: string;
	result?: AgentResult;
	error?: string;
};

export type SpawnAgentResponse =
	| {
			status: "background";
			agentId: string;
			description: string;
	  }
	| {
			status: "completed";
			agentId: string;
			result: AgentResult;
	  };

export type AgentRuntimeEvent = {
	type: "agent_status" | "inbox" | "scheduler_stalled" | "scheduler_error";
	agentId: string;
	recipientId?: string;
	record?: AgentRecord;
	message?: string;
};

export type AgentRuntimeListener = (event: AgentRuntimeEvent) => void;

export type TaskRuntime = {
	create(
		requesterState: AgentState,
		drafts: readonly TaskDraft[],
	): Promise<Task[]>;
	get(requesterState: AgentState, taskId: string): Promise<Task | undefined>;
	list(
		requesterState: AgentState,
		filter?: {
			readyOnly?: boolean;
			status?: readonly TaskStatus[];
			unownedOnly?: boolean;
		},
	): Promise<Task[]>;
	update(
		requesterState: AgentState,
		request: TaskUpdateRequest,
	): Promise<TaskUpdateOutcome>;
};

export type AgentRuntime = {
	readonly tasks?: TaskRuntime;
	attach?(state: AgentState): void;
	spawn(
		parentState: AgentState,
		request: SpawnAgentRequest,
	): Promise<SpawnAgentResponse>;
	list(requesterState: AgentState): AgentRecord[];
	wait(
		requesterState: AgentState,
		agentId: string,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<AgentResult>;
	send(
		requesterState: AgentState,
		agentId: string,
		content: string,
	): { messageId: string };
	cancel(
		requesterState: AgentState,
		agentId: string,
		reason?: string,
	): Promise<boolean>;
	drainMessages(agentId: string): Message[];
	drainMemory?(agentId: string): AgentMemoryUpdate;
	beginCompletion?(agentId: string): void;
	hasPendingMessages(agentId: string): boolean;
	subscribe(listener: AgentRuntimeListener): () => void;
	shutdown(): Promise<void>;
};
