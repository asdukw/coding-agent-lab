import type { ModelClient } from './model/client'
import type { AgentState, Message } from './state'

export type QueryParams = {
  initialState: AgentState
  model: ModelClient
}

export type Terminal = {
  reason: 'complete' | 'max_turns' | 'model_error'
  state: AgentState
}

export type QueryEvent =
  | {
      type: 'request_start'
      model: string
    }
  | {
      type: 'stream_delta'
      content: string
    }
  | {
      type: 'message'
      message: Message
    }
  | {
      type: 'state'
      state: AgentState
    }
  | {
      type: 'terminal'
      terminal: Terminal
    }

export async function* query({
  initialState,
  model,
}: QueryParams): AsyncGenerator<QueryEvent, Terminal> {
  const state: AgentState = {
    ...initialState,
    todos: [
      {
        id: '1',
        content: 'Initialize TypeScript agent loop',
        status: 'done',
      },
    ],
    turn: initialState.turn + 1,
    budget: {
      ...initialState.budget,
      turnsUsed: initialState.budget.turnsUsed + 1,
    },
    transition: { reason: 'next_turn' },
  }

  yield {
    type: 'request_start',
    model: model.name,
  }

  let finalAnswer = ''
  for await (const delta of model.stream({
    messages: state.messages,
  })) {
    finalAnswer += delta
    yield {
      type: 'stream_delta',
      content: delta,
    }
  }

  state.finalAnswer = finalAnswer
  state.transition = { reason: 'complete' }

  const assistantMessage: Message = {
    role: 'assistant',
    content: finalAnswer,
  }

  state.messages = [...state.messages, assistantMessage]

  yield {
    type: 'message',
    message: assistantMessage,
  }

  yield {
    type: 'state',
    state,
  }

  const terminal: Terminal = {
    reason: 'complete',
    state,
  }

  yield {
    type: 'terminal',
    terminal,
  }

  return terminal
}
