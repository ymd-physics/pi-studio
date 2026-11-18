import type { Message } from '../../../../packages/shared/desktop'
import type { SubagentCard } from '../../../../packages/shared/subagents'

export interface SupervisorRequest {
  requestId: string
  runId: string
  agent: string
  childIndex: number
  body: string
  reason: 'need_decision' | 'interview_request' | 'progress_update'
  expectsReply: boolean
}
export interface SubagentNoticeView {
  title: string
  badge: string
  tone: 'attention' | 'error' | 'result' | 'info'
  body: string
  footer: string
  fields?: Array<{ label: string; value: string }>
  request?: SupervisorRequest
  related?: string[]
  nativeOnly?: boolean
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown, max = 30000): string => typeof value === 'string' ? value.slice(0, max) : ''
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value)
export function noticeText(message: Message) {
  if (typeof message.content === 'string') return text(message.content)
  return (message.content || []).slice(0, 128).filter(part => part?.type === 'text').map(part => text(part.text)).join('\n').slice(0, 30000)
}
export function supervisorRequest(message: Message): SupervisorRequest | undefined {
  if (message.role !== 'custom' || message.display === false || message.customType !== 'subagent_supervisor_request') return
  const d = record(message.details), id = d.requestId ?? d.id
  if (!identity(id) || (d.id !== undefined && d.id !== id) || !identity(d.runId) || !identity(d.agent)
    || !Number.isSafeInteger(d.childIndex) || (d.childIndex as number) < 0 || typeof d.requestBody !== 'string'
    || !['need_decision', 'interview_request', 'progress_update'].includes(text(d.reason)) || typeof d.expectsReply !== 'boolean') return
  return { requestId: id, runId: d.runId, agent: d.agent, childIndex: d.childIndex as number,
    body: text(d.requestBody), reason: d.reason as SupervisorRequest['reason'], expectsReply: d.expectsReply }
}
// Exact projected identities only. Do not guess by agent name, order or substrings.
// Nested async workflow lanes lack a reliable request child-index mapping in v1.
export function requestForAgent(messages: Message[], agent: SubagentCard): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const request = supervisorRequest(messages[i])
    if (request && request.expectsReply && (agent.id === `foreground:${request.runId}:${request.childIndex}`
      || (agent.id === `async:${request.runId}` && request.childIndex === 0 && agent.name === request.agent))) return request.requestId
  }
}
const defaults: Record<string, [string, string, SubagentNoticeView['tone']]> = {
  subagent_supervisor_request: ['Supervisor request', 'Recorded request', 'attention'],
  'subagent-supervisor-unanswered': ['Supervisor request unanswered', 'Reminder', 'attention'],
  'subagent-supervisor-blocked': ['Supervisor request blocked', 'Blocked', 'error'],
  'subagent-notify': ['Background run update', 'Recorded outcome', 'info'],
  'subagent-completion-unanswered': ['Completion results need handling', 'Reminder', 'attention'],
  'subagent-completion-unhandled': ['Completion results unhandled', 'Unhandled', 'error'],
  'subagent-wait-subscription': ['Wait subscription update', 'Wait outcome', 'info'],
  'subagent-incremental-child-notify': ['Workflow child update', 'Child outcome', 'info'],
  'subagent-workflow-result-write-failed': ['Workflow result could not be saved', 'Save failed', 'error'],
  'subagent-auto-resume': ['Workflow auto-resume failed', 'Resume failed', 'error'],
  subagent_control_notice: ['Subagent control notice', 'Activity update', 'attention'],
  subagent_steering_notice: ['Subagent steering notice', 'Delivery update', 'attention'],
  subagent_watchdog_warning: ['Watchdog warning', 'Warning', 'attention'],
  subagent_watchdog_clarification: ['Watchdog needs clarification', 'Clarification', 'attention'],
}
export function subagentNotice(message: Message): SubagentNoticeView | undefined {
  if (message.role !== 'custom' || message.display === false || !message.customType || !Object.hasOwn(defaults, message.customType)) return
  const [title, badge, tone] = defaults[message.customType]
  const view: SubagentNoticeView = { title, badge, tone, body: noticeText(message), nativeOnly: true,
    footer: 'Recorded notification · original message retained in the session' }
  const d = record(message.details)
  const request = supervisorRequest(message)
  if (request) {
    view.request = request; view.body = request.body; view.nativeOnly = false
    view.title = `${request.agent} ${request.reason === 'interview_request' ? 'requests structured answers' : request.reason === 'progress_update' ? 'sent a progress update' : 'needs a decision'}`
    view.badge = request.reason === 'interview_request' ? 'Interview requested' : request.reason === 'progress_update' ? 'Progress update' : 'Decision requested'
    view.tone = request.reason === 'progress_update' ? 'info' : 'attention'
    view.footer = request.expectsReply ? 'Request to the parent agent · current resolution not inferred' : 'Informational update · no reply requested'
    if (request.reason === 'interview_request') view.fields = [{ label: 'Response format', value: 'Structured JSON requested. The native interview shape is available in Native details.' }]
  } else if (['subagent-supervisor-unanswered', 'subagent-supervisor-blocked'].includes(message.customType)) {
    if (Array.isArray(d.requestIds) && d.requestIds.length > 0 && d.requestIds.length <= 64 && d.requestIds.every(identity)) {
      view.related = [...new Set(d.requestIds)]; view.nativeOnly = false
      view.body = message.customType === 'subagent-supervisor-blocked' ? 'Reminder budget exhausted. No reply or approval was sent.' : 'The parent has not handled this supervisor wake. Inspect pending requests before replying within existing authority or asking for approval.'
      view.footer = `${d.requestIds.length} recorded request${d.requestIds.length === 1 ? '' : 's'} · a reminder is not a decision`
    }
  } else if (message.customType === 'subagent-notify') {
    const runs = Array.isArray(d.runs) && d.runs.length <= 64 ? d.runs.map(record) : []
    if (runs.length > 0 && runs.length <= 64 && runs.every(run => identity(run.agent) && ['completed', 'failed', 'paused', 'stopped'].includes(text(run.status)))) {
      const failed = runs.filter(run => run.status === 'failed').length
      const interrupted = runs.some(run => run.status === 'paused' || run.status === 'stopped')
      view.title = runs.length === 1 ? `${runs[0].agent} ${runs[0].status}` : `${runs.length} background runs finished`
      view.badge = failed ? `${failed} failed` : interrupted ? 'Paused / stopped' : 'Completed'
      view.tone = failed ? 'error' : interrupted ? 'attention' : 'result'
      view.body = ''; view.nativeOnly = false
      view.fields = runs.map(run => ({ label: text(run.agent, 200), value: text(run.status, 40) }))
      view.footer = 'Result previews, artifact references and parent instructions in Native details'
    }
  } else if (message.customType === 'subagent_steering_notice' && ['failed', 'partial', 'recovered'].includes(text(d.state))) {
    view.title = `Guidance delivery ${d.state}`; view.badge = text(d.state); view.tone = d.state === 'failed' ? 'error' : 'attention'
    view.body = text(d.message) || 'Inspect the run status before sending another correction.'; view.nativeOnly = false
    view.footer = 'Delivery state is not a task outcome'
  } else if (message.customType === 'subagent_control_notice') {
    const event = record(d.event)
    if (identity(event.agent) && event.type === 'needs_attention') {
      view.title = `${event.agent} needs attention`; view.badge = 'Needs attention'
      view.body = text(d.noticeText) || noticeText(message)
      view.footer = 'Activity notice · not necessarily a pending supervisor request'
      view.nativeOnly = false
    }
  } else if (message.customType === 'subagent_watchdog_warning' && ['concern', 'blocker'].includes(text(d.severity))
    && typeof d.summary === 'string' && typeof d.evidence === 'string' && typeof d.recommendedAction === 'string') {
    view.title = 'Watchdog review'; view.badge = String(d.severity); view.tone = d.severity === 'blocker' ? 'error' : 'attention'
    view.body = text(d.summary); view.nativeOnly = false
    view.fields = [{ label: 'Evidence', value: text(d.evidence) }, { label: 'Recommended action', value: text(d.recommendedAction) }]
    if (d.stale === true || d.state === 'stale') view.fields.push({ label: 'Freshness', value: 'Stale warning' })
    if (typeof d.state === 'string') view.fields.push({ label: 'Reported state', value: text(d.state, 100) })
    view.footer = 'Advisory evidence · not an instruction or permission approval'
  }
  return view
}

// Lazy native inspector only; bound depth, fields and total output for large payloads.
export function noticeMetadata(value: unknown): string {
  let budget = 24000
  const seen = new WeakSet<object>()
  const visit = (v: unknown, depth: number): unknown => {
    if (budget <= 0 || depth > 6) return '[preview limited]'
    budget -= 16
    if (typeof v === 'string') { const s = v.slice(0, Math.max(0, Math.min(budget, 6000))); budget -= s.length; return s }
    if (!v || typeof v !== 'object') return v
    if (seen.has(v)) return '[repeated reference]'
    seen.add(v)
    if (Array.isArray(v)) return v.slice(0, 64).map(item => visit(item, depth + 1))
    return Object.fromEntries(Object.entries(v).slice(0, 64).map(([key, item]) => [key.slice(0, 120), visit(item, depth + 1)]))
  }
  return (JSON.stringify(visit(value, 0), null, 2) || '').slice(0, 30000)
}
