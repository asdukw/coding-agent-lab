import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import type { ModelClient, ModelRequest } from './client'

export type DeepSeekModelOptions = {
  apiKey: string
  baseURL?: string
  model?: string
}

export class DeepSeekModelClient implements ModelClient {
  readonly name: string
  private readonly client: OpenAI
  private readonly model: string

  constructor(options: DeepSeekModelOptions) {
    this.model = options.model ?? 'deepseek-v4-flash'
    this.name = `deepseek:${this.model}`
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? 'https://api.deepseek.com',
    })
  }

  async *stream(request: ModelRequest): AsyncGenerator<string> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(request),
      stream: true,
    })

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content
      if (content) {
        yield content
      }
    }
  }
}

function toOpenAIMessages(request: ModelRequest): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = []

  for (const message of request.messages) {
    switch (message.role) {
      case 'system':
        messages.push({ role: 'system', content: message.content })
        break
      case 'user':
        messages.push({ role: 'user', content: message.content })
        break
      case 'assistant':
        messages.push({ role: 'assistant', content: message.content })
        break
      case 'tool':
        break
    }
  }

  return messages
}
