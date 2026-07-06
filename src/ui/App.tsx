import React, { useEffect, useState } from 'react'
import { Box, Text, useApp } from 'ink'
import type { ModelClient } from '../model/client'
import { query, type Terminal } from '../query'
import { createInitialState } from '../state'

export type AppProps = {
  task?: string
  cwd: string
  model: ModelClient
}

export function App({ task, cwd, model }: AppProps) {
  const { exit } = useApp()
  const [modelName, setModelName] = useState<string | undefined>()
  const [assistantText, setAssistantText] = useState('')
  const [terminal, setTerminal] = useState<Terminal | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [, setIdleTick] = useState(0)

  useEffect(() => {
    if (task) {
      return
    }

    const timer = setInterval(() => {
      setIdleTick(current => current + 1)
    }, 1_000)

    return () => {
      clearInterval(timer)
    }
  }, [task])

  useEffect(() => {
    if (!task) {
      return
    }

    let canceled = false

    void (async () => {
      try {
        const initialState = createInitialState(task, cwd)
        for await (const event of query({ initialState, model })) {
          if (canceled) {
            return
          }

          if (event.type === 'request_start') {
            setModelName(event.model)
          } else if (event.type === 'stream_delta') {
            setAssistantText(current => current + event.content)
          } else if (event.type === 'message') {
            setAssistantText(event.message.content)
          } else if (event.type === 'terminal') {
            setTerminal(event.terminal)
            setTimeout(exit, 50)
          }
        }
      } catch (caught) {
        if (!canceled) {
          setError(caught instanceof Error ? caught.message : String(caught))
          exit()
        }
      }
    })()

    return () => {
      canceled = true
    }
  }, [cwd, exit, model, task])

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text color="cyan">cagent</Text>
        <Text color="gray">cwd: {cwd}</Text>
        {modelName ? <Text color="gray">model: {modelName}</Text> : null}
      </Box>

      {task ? (
        <Box flexDirection="column">
          <Text color="green">user</Text>
          <Text>{task}</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color="green">ready</Text>
          <Text color="gray">No task submitted. Press Ctrl+C to exit.</Text>
        </Box>
      )}

      {task ? (
        <Box flexDirection="column">
          <Text color="blue">assistant</Text>
          <Text>{assistantText || '...'}</Text>
        </Box>
      ) : null}

      {terminal ? (
        <Text color="gray">
          done: {terminal.reason}, turns: {terminal.state.turn}
        </Text>
      ) : null}

      {error ? <Text color="red">error: {error}</Text> : null}
    </Box>
  )
}
