import { expect, it } from 'vitest'
import { ActivityTracker } from './activity'

it('normalizes delta-only RPC thinking, preserves contiguous groups and freezes at the next block', () => {
  let now = 0
  const tracker = new ActivityTracker(() => now)
  tracker.handle({ type: 'message_start', message: { role: 'assistant', timestamp: 1, content: [] } })
  tracker.handle({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
  })
  now = 3000
  tracker.handle({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Consider this' },
  })
  tracker.handle({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Consider this' },
  })
  expect(tracker.view().thoughts['assistant:1:thinking:0']).toEqual({ started: 0 })
  now = 5000
  tracker.handle({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } })
  expect(tracker.view().thoughts['assistant:1:thinking:0']).toEqual({ started: 0, ended: 5000 })
  now = 8000
  tracker.handle({
    type: 'message_end',
    message: {
      role: 'assistant',
      timestamp: 1,
      content: [
        { type: 'thinking', thinking: 'Consider this' },
        { type: 'text', text: 'Done' },
      ],
    },
  })
  expect(tracker.view().thoughts['assistant:1:thinking:0'].ended).toBe(5000)
  tracker.reset()
  tracker.handle({
    type: 'message_end',
    message: { role: 'assistant', timestamp: 1, content: [{ type: 'thinking', thinking: 'Historical' }] },
  })
  expect(tracker.view().thoughts).toEqual({})
})
it('keeps the dispatch clock until settlement and calculates throughput including TTFT but excluding tools', () => {
  let now = 0
  const tracker = new ActivityTracker(() => now)
  tracker.dispatch()
  now = 500
  tracker.handle({ type: 'agent_start' })
  tracker.handle({ type: 'turn_start' })
  tracker.handle({ type: 'message_start', message: { role: 'assistant', timestamp: 1, content: [] } })
  now = 4500
  tracker.handle({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' },
  })
  now = 5500
  tracker.handle({
    type: 'message_end',
    message: {
      role: 'assistant',
      timestamp: 1,
      content: [{ type: 'text', text: 'Hello' }],
      usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.001 } },
    },
  })
  now = 15500 // 10s of tools must not dilute throughput
  tracker.handle({ type: 'turn_end' })
  tracker.handle({ type: 'agent_end' })
  tracker.handle({ type: 'auto_retry_start' })
  tracker.handle({ type: 'agent_start' })
  expect(tracker.view().active?.started).toBe(0)
  expect(tracker.view().completed).toEqual({})
  now = 16000
  const view = tracker.handle({ type: 'agent_settled' })
  expect(view.active).toBeUndefined()
  expect(view.completed['assistant:1']).toMatchObject({
    totalMs: 16000,
    generationMs: 5000,
    ttftMs: 4000,
    input: 100,
    output: 20,
  })
  expect(view.completed['assistant:1'].output! / (view.completed['assistant:1'].generationMs / 1000)).toBe(4)
})
it('uses execution events before toolResult arrives and resolves interrupted calls without session writes', () => {
  const tracker = new ActivityTracker(() => 0)
  tracker.handle({
    type: 'message_start',
    message: {
      role: 'assistant',
      timestamp: 1,
      content: [
        { type: 'toolCall', id: 'a', name: 'bash' },
        { type: 'toolCall', id: 'b', name: 'read' },
      ],
    },
  })
  expect(tracker.view().tools.a.status).toBe('pending')
  tracker.handle({ type: 'tool_execution_start', toolCallId: 'a', args: { command: 'echo hello' } })
  tracker.handle({
    type: 'tool_execution_update',
    toolCallId: 'a',
    partialResult: { content: [{ type: 'text', text: 'partial' }] },
  })
  expect(tracker.view().tools.a).toMatchObject({ status: 'running', args: { command: 'echo hello' } })
  tracker.handle({
    type: 'tool_execution_end',
    toolCallId: 'a',
    isError: true,
    result: { content: [{ type: 'text', text: 'exit code 1' }] },
  })
  expect(tracker.view().tools.a.status).toBe('failed')
  tracker.handle({ type: 'agent_settled' })
  expect(tracker.view().tools.b.status).toBe('failed')
  expect(tracker.view().tools.a.result?.content).toEqual([{ type: 'text', text: 'exit code 1' }])
})
it('keeps distinct thinking clocks when assistant messages share a timestamp', () => {
  let now = 0
  const tracker = new ActivityTracker(() => now)
  const message = { role: 'assistant', timestamp: 1, content: [{ type: 'thinking', thinking: 'Reasoning' }] }
  tracker.handle({ type: 'message_start', message })
  now = 1000
  tracker.handle({ type: 'message_end', message })
  now = 2000
  tracker.handle({ type: 'message_start', message })
  now = 4000
  tracker.handle({ type: 'message_end', message })
  expect(tracker.view().thoughts['assistant:1:thinking:0']).toEqual({ started: 0, ended: 1000 })
  expect(tracker.view().thoughts['assistant:1#1:thinking:0']).toEqual({ started: 2000, ended: 4000 })
})
it('does not create telemetry for handled commands, and resets session-local observations', () => {
  const tracker = new ActivityTracker(() => 0)
  tracker.dispatch()
  expect(tracker.handled().active).toBeUndefined()
  expect(tracker.view().completed).toEqual({})
  tracker.handle({ type: 'tool_execution_start', toolCallId: 'a' })
  expect(tracker.reset()).toEqual({ thoughts: {}, tools: {}, completed: {} })
})
