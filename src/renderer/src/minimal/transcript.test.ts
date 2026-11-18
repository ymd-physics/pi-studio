import { expect, it } from 'vitest'
import { applyMessageEvent } from './transcript'
import type { Message } from '../../../../packages/shared/desktop'

it('reconstructs delta-only text, thinking and tool blocks, then adopts authoritative final output', () => {
  let messages: Message[] = []
  const apply = (type: string, data: any) => {
    messages = applyMessageEvent(messages, { type, ...data })
  }
  apply('message_start', { message: { role: 'user', content: 'hello', timestamp: 1 } })
  apply('message_end', { message: { role: 'user', content: 'hello', timestamp: 1 } })
  apply('message_start', { message: { role: 'assistant', content: [], timestamp: 2, stopReason: 'pending' } })
  const update = (type: string, contentIndex: number, fields = {}) =>
    apply('message_update', { assistantMessageEvent: { type, contentIndex, ...fields } })
  update('thinking_delta', 0, { delta: 'Consider ' })
  update('thinking_end', 0, { content: 'Consider this.' })
  update('text_delta', 1, { delta: 'Hello ' })
  update('text_delta', 1, { delta: 'world' })
  update('toolcall_start', 2, { id: 'call', toolName: 'read' })
  update('toolcall_delta', 2, { delta: '{"path":"file"}' })
  expect(messages).toHaveLength(2)
  expect(messages[1].content).toEqual([
    { type: 'thinking', thinking: 'Consider this.' },
    { type: 'text', text: 'Hello world' },
    { type: 'toolCall', id: 'call', name: 'read' },
  ])
  const final = {
    role: 'assistant',
    timestamp: 2,
    content: [{ type: 'text', text: 'Final authoritative message' }],
  }
  apply('message_end', { message: final })
  expect(messages[1]).toEqual(final)
})
it('supports older Pi cumulative message_update records without duplicating text', () => {
  const old: Message[] = [{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }]
  expect(
    applyMessageEvent(old, {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ab' }] },
      assistantMessageEvent: { type: 'text_delta', delta: 'b' },
    })[0].content,
  ).toEqual([{ type: 'text', text: 'ab' }])
})
