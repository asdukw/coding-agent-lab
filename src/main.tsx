import { createInitialState } from './state'
import { query } from './query'
import { createModelClientFromEnv } from './model'

async function main(): Promise<void> {
  const task = process.argv.slice(2).join(' ') || 'Demonstrate the coding agent loop'
  const state = createInitialState(task, process.cwd())
  const model = createModelClientFromEnv()

  for await (const event of query({ initialState: state, model })) {
    if (event.type === 'request_start') {
      console.error(`model: ${event.model}`)
    } else if (event.type === 'stream_delta') {
      process.stdout.write(event.content)
    } else if (event.type === 'terminal') {
      process.stdout.write('\n')
    }
  }
}

await main()
