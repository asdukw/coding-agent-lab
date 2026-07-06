import type { Message } from '../state'

export type ModelRequest = {
  messages: Message[]
}

export type ModelClient = {
  name: string
  stream(request: ModelRequest): AsyncGenerator<string>
}
