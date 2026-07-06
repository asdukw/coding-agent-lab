import type { ModelClient, ModelRequest } from './client'

export class StubModelClient implements ModelClient {
  readonly name = 'stub'

  async *stream(request: ModelRequest): AsyncGenerator<string> {
    const lastMessage = request.messages.at(-1)
    yield `Stub agent received task: ${lastMessage?.content ?? ''}`
  }
}
