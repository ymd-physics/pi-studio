import { useUiText } from './language'
import { useEffect, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, CircleAlert, Clock, LoaderCircle, MessageSquareWarning, Pause, Square, Terminal } from 'lucide-react'
import type { SubagentCard, SubagentStatus } from '../../../../packages/shared/subagents'
import './subagent-focus-card.css'

const labels: Record<SubagentCard['state'], string> = {
  running: 'Running', queued: 'Queued', waiting: 'Needs attention', complete: 'Complete',
  failed: 'Failed', stopped: 'Stopped', paused: 'Paused', unknown: 'Status unavailable',
}
const icons = { running: LoaderCircle, queued: Clock, waiting: MessageSquareWarning, complete: Check, failed: CircleAlert, stopped: Square, paused: Pause, unknown: CircleAlert }
const timestamp = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
const terminal = (agent: SubagentCard) => ['complete', 'failed', 'stopped', 'paused', 'unknown'].includes(agent.state)
const attention = (agent: SubagentCard) => ['waiting', 'failed', 'paused', 'unknown'].includes(agent.state)

export function SubagentFocusCard({ status, active, requestForAgent, onRequest }: { status: SubagentStatus | undefined; active: boolean; requestForAgent?: (agent: SubagentCard) => string | undefined; onRequest?: (id: string) => void }) {
  const t = useUiText()
  const [known, setKnown] = useState<SubagentStatus>()
  const [observedEnds, setObservedEnds] = useState<Map<string, { state: SubagentCard['state']; time: number }>>(() => new Map())
  const [selectedId, setSelectedId] = useState<string>()
  const [, tick] = useState(0)
  const now = Date.now()

  useEffect(() => {
    if (status?.availability !== 'available' || status.error) return
    setKnown(status)
    setObservedEnds(previous => {
      const ids = new Set(status.agents.map(agent => agent.id))
      const next = new Map([...previous].filter(([id]) => ids.has(id)))
      for (const agent of status.agents) {
        // Keep the first terminal observation across paging, hiding and snapshot refreshes.
        if (terminal(agent) && next.get(agent.id)?.state !== agent.state) next.set(agent.id, { state: agent.state, time: timestamp(agent.endedAt) ?? Date.now() })
        if (!terminal(agent)) next.delete(agent.id)
      }
      return next
    })
  }, [status])

  const snapshot = status?.error ? known : status?.availability === 'available' ? status : undefined
  const agents = (snapshot?.agents ?? []).filter(agent => agent.state !== 'complete' || now < (observedEnds.get(agent.id)?.state === agent.state ? observedEnds.get(agent.id)!.time : timestamp(agent.endedAt) ?? now) + 10_000)
  const index = Math.max(0, agents.findIndex(agent => agent.id === selectedId))
  const agent = agents[index]
  const needsTimer = agents.some(item => (!status?.error && item.state === 'running') || item.state === 'complete')

  useEffect(() => {
    if (!active || !needsTimer) return
    const timer = setInterval(() => tick(value => value + 1), 250)
    return () => clearInterval(timer)
  }, [active, needsTimer])
  useEffect(() => {
    if (agent && selectedId !== agent.id) setSelectedId(agent.id)
  }, [agent?.id, selectedId])

  if (!active || !agent) return null
  const Icon = icons[agent.state]
  const end = terminal(agent) ? (observedEnds.get(agent.id)?.state === agent.state ? observedEnds.get(agent.id)!.time : timestamp(agent.endedAt) ?? now) : timestamp(agent.endedAt) ?? (status?.error ? snapshot?.updatedAt ?? now : now)
  const start = timestamp(agent.startedAt)
  const seconds = start === undefined ? undefined : Math.max(0, Math.floor((end - start) / 1000))
  const elapsed = seconds === undefined ? t('Time unavailable') : t('{minutes}m {seconds}s', { minutes: Math.floor(seconds / 60), seconds: String(seconds % 60).padStart(2, '0') })
  // The status adapter joins progress fields with this separator. Only localize
  // known status/count fields; leave tool names and diagnostic text untouched.
  const activity = agent.activity?.split(' · ').map(part => {
    const count = /^(\d+) tools$/.exec(part)
    if (count) return t('{count} tools', { count: count[1] })
    return ['Result in conversation', 'Delegation failed', 'Final child status unavailable', 'Delegation failed; child status unavailable', 'running', 'queued', 'paused', 'stopped', 'failed', 'waiting', 'waiting_for_user', 'waiting_for_supervisor', 'awaiting_supervisor', 'needs_attention'].includes(part) ? t(part) : part
  }).join(' · ')
  const attentionAgents = agents.filter(attention)
  const selectAttention = () => {
    const next = (attentionAgents.findIndex(item => item.id === agent.id) + 1) % attentionAgents.length
    const selected = attentionAgents[next]
    setSelectedId(selected.id)
    const requestId = requestForAgent?.(selected)
    if (requestId && !status?.error) onRequest?.(requestId)
  }

  const requestId = !status?.error ? requestForAgent?.(agent) : undefined
  return (
    <section className="subagent-focus" aria-label={t("Subagent activity")}>
      <div className="subagent-focus-header">
        <strong>{t("Subagents")}</strong>
        <span className="subagent-focus-counts">{t('{running} running · {queued} queued · {total} total', { running: agents.filter(item => item.state === 'running').length, queued: agents.filter(item => item.state === 'queued').length, total: agents.length })}{snapshot?.omitted ? ` · ${t('{count} more not reported', { count: snapshot.omitted })}` : ''}</span>
        {attentionAgents.length > 0 && <button className="subagent-focus-attention" onClick={selectAttention}>{t('{count} needs attention', { count: attentionAgents.length })}</button>}
        <div className="subagent-focus-pager">
          <button aria-label={t("Previous agent")} disabled={index === 0} onClick={() => setSelectedId(agents[index - 1].id)}><ChevronLeft /></button>
          <span>{index + 1} / {agents.length}</span>
          <button aria-label={t("Next agent")} disabled={index === agents.length - 1} onClick={() => setSelectedId(agents[index + 1].id)}><ChevronRight /></button>
        </div>
      </div>
      {status?.error && <div className="subagent-focus-stale" role="status">{t("Stale subagent status —") + ' '}{status.error}</div>}
      <article className="subagent-focus-card" data-state={agent.state}>
        <div className="subagent-focus-top">
          <span className="subagent-focus-icon"><Icon className={agent.state === 'running' ? 'subagent-focus-spin' : undefined} aria-hidden="true" /></span>
          <strong className="subagent-focus-name" title={agent.name}>{agent.name === 'Subagent' ? t('Subagent') : agent.name || t('Name unavailable')}</strong>
        </div>
        <div className="subagent-focus-status">
          <span className="subagent-focus-state">{t(labels[agent.state])}</span>
          {requestId && onRequest && <button className="subagent-focus-request" onClick={() => onRequest(requestId)}>{t("View recorded request ↑")}</button>}
          <span className="subagent-focus-elapsed" data-unavailable={seconds === undefined}>{elapsed}</span>
        </div>
        <p className="subagent-focus-task" title={agent.task}>{agent.task || t('Task unavailable')}</p>
        <div className="subagent-focus-meta">
          <span className="subagent-focus-model" title={agent.model}>{agent.model || t('Model unavailable')}</span>
          <span className="subagent-focus-thinking" title={t("Thinking level")}>{t(agent.thinking || 'Thinking unavailable')}</span>
        </div>
        <span className="subagent-focus-activity" title={activity}><Terminal aria-hidden="true" /><span>{activity || t('Activity unavailable')}</span></span>
      </article>
    </section>
  )
}
