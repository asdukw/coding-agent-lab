import { expect, test } from 'bun:test'
import { DeepSeekModelClient } from '../src/model/deepseek'

const apiKey = process.env.DEEPSEEK_API_KEY

if (!apiKey) {
  test.skip('streams a response from DeepSeek', async () => {})
} else {
  test(
    'streams a response from DeepSeek',
    async () => {
      const client = new DeepSeekModelClient({
        apiKey,
        baseURL: process.env.DEEPSEEK_BASE_URL,
        model: process.env.DEEPSEEK_MODEL,
      })

      let output = ''
      for await (const delta of client.stream({
        messages: [
          {
            role: 'system',
            content: 'Reply with a very short confirmation.',
          },
          {
            role: 'user',
            content: 'Connectivity check.',
          },
        ],
      })) {
        output += delta
      }

      expect(output.trim().length).toBeGreaterThan(0)
    },
    30_000,
  )
}
