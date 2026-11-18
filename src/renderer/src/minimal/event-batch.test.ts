import { afterEach, expect, it, vi } from 'vitest'
import { EventBatch } from './event-batch'
import { applyMessageEvent } from './transcript'
import { withNotices } from './notices'
afterEach(() => vi.useRealTimers())
it('coalesces visual deltas without dropping characters and flushes before dialogs/final messages', () => {
  vi.useFakeTimers()
  const receive = vi.fn(),
    batch = new EventBatch(receive, () => true)
  for (let i = 0; i < 100; i++)
    batch.push({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: String(i) + ',' },
    })
  expect(receive).not.toHaveBeenCalled()
  batch.push({ type: 'extension_ui_request', method: 'confirm' })
  expect(receive).toHaveBeenCalledTimes(2)
  expect(receive.mock.calls[0][0].assistantMessageEvent.delta).toBe(
    Array.from({ length: 100 }, (_, i) => String(i) + ',').join(''),
  )
  expect(receive.mock.calls[1][0].method).toBe('confirm')
  vi.runAllTimers()
  expect(receive).toHaveBeenCalledTimes(2)
})
it('preserves content boundaries, final text and background ordering', () => {
  vi.useFakeTimers()
  let messages = applyMessageEvent([], {
    type: 'message_start',
    message: { role: 'assistant', timestamp: 1, content: [] },
  })
  const batch = new EventBatch(
    (e) => {
      messages = applyMessageEvent(messages, e)
    },
    () => false,
  )
  for (const [type, contentIndex, delta] of [
    ['thinking_delta', 0, 'think'],
    ['text_delta', 1, 'one'],
    ['text_delta', 1, ' two'],
  ] as const)
    batch.push({ type: 'message_update', assistantMessageEvent: { type, contentIndex, delta } })
  vi.advanceTimersByTime(32)
  expect(messages[0].content).toEqual([])
  vi.advanceTimersByTime(168)
  expect(messages[0].content).toEqual([
    { type: 'thinking', thinking: 'think' },
    { type: 'text', text: 'one two' },
  ])
  batch.push({
    type: 'message_end',
    message: { role: 'assistant', timestamp: 1, content: [{ type: 'text', text: 'exact final' }] },
  })
  expect(messages[0].content).toEqual([{ type: 'text', text: 'exact final' }])
  batch.dispose()
})
it('merges UI-only notices at their anchor and retains notices whose anchor was compacted', () => {
  const messages = [
    { role: 'user', timestamp: 1, content: 'question' },
    { role: 'assistant', timestamp: 2, content: 'answer' },
  ]
  const notes = [
    { id: 3, after: 'user:1', text: 'info', level: 'info' as const },
    { id: 4, after: 'assistant:0', text: 'older error', level: 'error' as const },
  ]
  const projected = withNotices(messages, notes)
  expect(projected.map((m) => m.content)).toEqual(['older error', 'question', 'info', 'answer'])
  expect(messages).toHaveLength(2)
})
