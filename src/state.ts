export type Role = "user" | "assistant" | "tool" | "system";

export type Message = {
  role: Role;
  content: string;
  /** Present on assistant messages that request tool calls. */
  toolCalls?: { id: string; name: string; arguments: string }[];
  /** Present on role:'tool' messages, linking back to the requesting call. */
  toolCallId?: string;
};

export type TodoItem = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "done" | "failed";
};

export type Observation = {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  output: string;
  exitCode?: number;
};

export type ToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type BudgetState = {
  turnsUsed: number;
  maxTurns: number;
};

export type TransitionReason =
  | "start"
  | "next_turn"
  | "tool_error"
  | "max_turns"
  | "complete"
  | "permission_denied";

export type AgentState = {
  task: string;
  cwd: string;
  messages: Message[];
  todos: TodoItem[];
  observations: Observation[];
  changedFiles: string[];
  turn: number;
  maxTurns: number;
  budget: BudgetState;
  lastToolCall?: ToolCall;
  finalAnswer?: string;
  transition?: {
    reason: TransitionReason;
  };
};

export function createInitialState(task: string, cwd: string): AgentState {
  return {
    task,
    cwd,
    messages: [{ role: "user", content: task }],
    todos: [],
    observations: [],
    changedFiles: [],
    turn: 0,
    maxTurns: 20,
    budget: {
      turnsUsed: 0,
      maxTurns: 20,
    },
    transition: { reason: "start" },
  };
}

export function continueState(prev: AgentState, task: string): AgentState {
  return {
    ...prev,
    task,
    messages: [...prev.messages, { role: "user", content: task }],
  };
}
