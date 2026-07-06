import type { Message } from '../state'
import type { Tools } from '../tools/types'

export type ModelRequest = {
  messages: Message[]
  tools?: Tools
}

export type ModelStreamEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }

export type ModelClient = {
  name: string
  stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent>
}
