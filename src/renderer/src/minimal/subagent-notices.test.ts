import { describe, expect, it } from 'vitest'
import type { Message } from '../../../../packages/shared/desktop'
import { noticeMetadata, noticeText, requestForAgent, subagentNotice, supervisorRequest } from './subagent-notices'
const request: Message = { role: 'custom', customType: 'subagent_supervisor_request', content: 'Protocol with Reply with: tool call', details: {
  requestId: 'req-1', runId: 'run-1', agent: 'reviewer', childIndex: 0, reason: 'need_decision', expectsReply: true, requestBody: 'Please supply the missing pages.' } }
const msg = (customType: string, details: Message['details'] = {}): Message => ({ role: 'custom', customType, details, content: 'Original text' })
describe('subagent notices', () => {
  it('uses the explicit request body without stripping or rewriting native content', () => {
    const before = JSON.stringify(request), view = subagentNotice(request)!
    expect(view.body).toBe('Please supply the missing pages.')
    expect(view.title).toBe('reviewer needs a decision')
    expect(view.footer).toContain('current resolution not inferred')
    expect(supervisorRequest(request)?.requestId).toBe('req-1')
    expect(JSON.stringify(request)).toBe(before)
  })
  it('distinguishes interview and nonblocking progress', () => {
    const interview = subagentNotice({ ...request, details: { ...request.details, reason: 'interview_request', interview: { questions: [] } } })!
    expect(interview.badge).toBe('Interview requested')
    expect(interview.fields?.[0].value).toContain('JSON')
    const progress = subagentNotice({ ...request, details: { ...request.details, reason: 'progress_update', expectsReply: false } })!
    expect(progress.tone).toBe('info')
    expect(progress.footer).toContain('no reply requested')
  })
  it('leaves hidden, unknown and ordinary assistant content alone', () => {
    expect(subagentNotice({ ...request, display: false })).toBeUndefined()
    expect(supervisorRequest({ ...request, display: false })).toBeUndefined()
    expect(subagentNotice({ ...request, role: 'assistant' })).toBeUndefined()
    expect(subagentNotice(msg('future_subagent_message'))).toBeUndefined()
    expect(subagentNotice(msg('constructor'))).toBeUndefined()
  })
  it('retains malformed/legacy requests as native-only without draft or routing affordances', () => {
    for (const details of [undefined, {}, { ...request.details, childIndex: -1 }, { ...request.details, id: 'contradiction' }, { ...request.details, requestId: 'x'.repeat(201) }, { ...request.details, expectsReply: 'true' }, { ...request.details, reason: { toString: null } }]) {
      const message = { ...request, details }
      expect(supervisorRequest(message)).toBeUndefined()
      expect(subagentNotice(message)).toMatchObject({ nativeOnly: true, body: request.content })
    }
  })
  it('does not confuse mixed results, stopped or paused with success', () => {
    const view = subagentNotice(msg('subagent-notify', { runs: [{ agent: 'scout', status: 'completed' }, { agent: 'reviewer', status: 'failed' }] }))!
    expect(view.title).toBe('2 background runs finished')
    expect(view.badge).toBe('1 failed')
    expect(view.fields).toHaveLength(2)
    for (const status of ['paused', 'stopped']) expect(subagentNotice(msg('subagent-notify', { runs: [{ agent: 'scout', status }] }))?.tone).toBe('attention')
    expect(subagentNotice(msg('subagent-notify', { runs: [{ agent: 'scout', status: 'completed' }] }))?.tone).toBe('result')
    expect(subagentNotice(msg('subagent-notify', { runs: [{ agent: 'scout', status: 'new-state' }] }))?.nativeOnly).toBe(true)
  })
  it('links reminder IDs without inferring approval or resolution', () => {
    const view = subagentNotice(msg('subagent-supervisor-blocked', { requestIds: ['req-1'] }))!
    expect(view.related).toEqual(['req-1'])
    expect(view.body).toContain('No reply or approval was sent')
    expect(subagentNotice(msg('subagent-supervisor-blocked', { requestIds: [7] }))?.nativeOnly).toBe(true)
  })
  it('distinguishes attention, steering delivery and watchdog evidence', () => {
    expect(subagentNotice(msg('subagent_control_notice', { event: { type: 'needs_attention', agent: 'reviewer' } }))?.request).toBeUndefined()
    expect(subagentNotice(msg('subagent_steering_notice', { state: 'recovered' }))?.footer).toBe('Delivery state is not a task outcome')
    const watchdog = subagentNotice(msg('subagent_watchdog_warning', { severity: 'blocker', summary: 'Missing evidence', evidence: 'Page 4 absent', recommendedAction: 'Read page 4', stale: true }))!
    expect(watchdog.tone).toBe('error')
    expect(watchdog.fields).toContainEqual({ label: 'Freshness', value: 'Stale warning' })
    expect(watchdog.footer).toContain('not an instruction')
  })
  it.each(['subagent-completion-unanswered', 'subagent-completion-unhandled', 'subagent-wait-subscription', 'subagent-incremental-child-notify', 'subagent-workflow-result-write-failed', 'subagent-auto-resume', 'subagent_watchdog_clarification'])('offers native fallback for %s without inventing missing details', customType => {
    expect(subagentNotice(msg(customType))).toMatchObject({ nativeOnly: true, body: 'Original text' })
  })
  it('routes only exact native identities, never matching names or child order', () => {
    const agent = { id: 'foreground:run-1:0', name: 'reviewer', state: 'waiting' as const }
    expect(requestForAgent([request], agent)).toBe('req-1')
    expect(requestForAgent([request], { ...agent, id: 'foreground:other:0' })).toBeUndefined()
    expect(requestForAgent([request], { ...agent, id: 'foreground:run-1:1' })).toBeUndefined()
    expect(requestForAgent([request], { ...agent, id: 'async:run-1' })).toBe('req-1')
    expect(requestForAgent([request], { ...agent, id: 'async:run-1/workflow-lane' })).toBeUndefined()
    expect(requestForAgent([{ ...request, display: false }], agent)).toBeUndefined()
  })
  it('bounds hostile/oversized native data and preserves text-only content', () => {
    const cyclic: Record<string, unknown> = { text: 'x'.repeat(100000) }; cyclic.self = cyclic
    expect(noticeMetadata(cyclic)).toContain('[repeated reference]')
    expect(noticeMetadata(cyclic).length).toBeLessThan(30000)
    expect(noticeText({ role: 'custom', content: 'x'.repeat(100000) })).toHaveLength(30000)
    expect(noticeText({ role: 'custom', content: [{ type: 'image', data: 'private' }, { type: 'text', text: 'Shown' }] })).toBe('Shown')
  })
})
