import { expect, it } from 'vitest'
import { ActivityTracker } from './activity'
it('observes standalone native compaction, estimates and original extension progress without an agent run', () => {
  let now = 10
  const tracker = new ActivityTracker(() => now)
  tracker.handle({ type: 'compaction_start', reason: 'manual' })
  expect(tracker.view().compaction?.status).toBe('running')
  expect(tracker.view().active).toBeUndefined()
  tracker.handle({
    type: 'extension_ui_request',
    method: 'notify',
    message: 'Custom compressor: working',
    notifyType: 'info',
  })
  now = 3010
  tracker.handle({
    type: 'compaction_end',
    reason: 'manual',
    result: { summary: 'Plugin summary', tokensBefore: 100000, estimatedTokensAfter: 12000 },
    aborted: false,
  })
  expect(tracker.view().compaction).toMatchObject({
    status: 'complete',
    started: 10,
    ended: 3010,
    result: { tokensBefore: 100000, estimatedTokensAfter: 12000 },
  })
  expect(tracker.view().compaction?.notices[0].text).toBe('Custom compressor: working')
  expect(tracker.view().completed).toEqual({})
})
it('keeps cancellation distinct from success, and a handled override does not invent a token reduction', () => {
  const tracker = new ActivityTracker(() => 0)
  tracker.handle({ type: 'desktop_compaction_command_start' })
  tracker.handle({ type: 'desktop_compaction_command_end' })
  expect(tracker.view().compaction?.status).toBe('handled')
  tracker.handle({ type: 'compaction_start' })
  tracker.handle({
    type: 'extension_ui_request',
    method: 'notify',
    message: 'Plugin refused request',
    notifyType: 'error',
  })
  tracker.handle({ type: 'compaction_end', aborted: true })
  tracker.handle({ type: 'desktop_compaction_command_end', error: 'Compaction cancelled' })
  expect(tracker.view().compaction?.status).toBe('cancelled')
  expect(tracker.view().compaction?.notices[0].text).toBe('Plugin refused request')
  expect(tracker.view().compaction?.result).toBeUndefined()
})
it('distinguishes a failed remote compressor from user cancellation despite native cancel semantics', () => {
  const tracker = new ActivityTracker(() => 0)
  tracker.handle({ type: 'compaction_start' })
  tracker.handle({
    type: 'extension_ui_request',
    method: 'setStatus',
    statusKey: 'pi-desktop-openai-compaction',
    statusText: 'OpenAI Codex · Compaction failed',
  })
  tracker.handle({
    type: 'extension_ui_request',
    method: 'notify',
    message: 'OpenAI Codex compaction failed (HTTP 401).',
    notifyType: 'error',
  })
  tracker.handle({ type: 'compaction_end', aborted: true })
  expect(tracker.view().compaction?.status).toBe('failed')
  expect(tracker.view().compaction?.notices.at(-1)?.text).toContain('401')
})
it('keeps native events authoritative when invoke replies overtake notification IPC', () => {
  const tracker = new ActivityTracker(() => 0)
  tracker.handle({ type: 'desktop_compaction_command_start' })
  tracker.handle({ type: 'compaction_start' })
  tracker.handle({ type: 'desktop_compaction_command_end', result: { summary: 'checkpoint' } })
  expect(tracker.view().compaction?.status).toBe('running')
  const text = 'x'.repeat(10001)
  tracker.handle({ type: 'extension_ui_request', method: 'notify', message: text })
  tracker.handle({
    type: 'extension_ui_request',
    method: 'setStatus',
    statusKey: 'pi-desktop-openai-compaction',
    statusText: 'OpenAI Codex · Compaction complete',
  })
  tracker.handle({
    type: 'compaction_end',
    result: { summary: 'checkpoint', details: { kind: 'openai-codex-native-compaction' } },
  })
  expect(tracker.view().compaction?.notices[0].text).toBe(text)
  expect(tracker.view().compaction?.engine).toBe('openai-codex')
  expect(tracker.view().compaction?.status).toBe('complete')
})
it('does not end an agent run for automatic compaction or carry completed status into a new request', () => {
  const tracker = new ActivityTracker(() => 0)
  tracker.handle({ type: 'agent_start' })
  tracker.handle({ type: 'compaction_start', reason: 'threshold' })
  tracker.handle({
    type: 'compaction_end',
    result: { summary: 'summary', tokensBefore: 12 },
    willRetry: true,
  })
  expect(tracker.view().active).toBeTruthy()
  expect(tracker.view().compaction?.status).toBe('complete')
  tracker.handle({ type: 'agent_settled' })
  expect(tracker.view().compaction?.status).toBe('complete')
  tracker.handle({ type: 'agent_start' })
  expect(tracker.view().compaction).toBeUndefined()
})
