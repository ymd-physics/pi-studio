import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ChevronRight,
  Layers,
  Check,
  CircleAlert,
  Circle,
  LoaderCircle,
  Brain,
  Clock3,
} from 'lucide-react'
import type { Message } from '../../../../packages/shared/desktop'
import { Markdown } from './Markdown'
import { ToolChanges } from './ToolChanges'
import { WebBackgroundNotice, WebToolResult } from './WebAccess'
import { SubagentNotice } from './SubagentNotice'
import { subagentNotice, supervisorRequest, type SupervisorRequest } from './subagent-notices'
import { backgroundNotice, isWebTool } from './web-access'
import { countGroupDiff } from './tool-diff'
import { countContentLines } from './toolChangePreview'
import { CompactionNotice } from './CompactionNotice'
import {
  ImageLightbox,
  ToolImageGrid,
  UserAttachments,
  type LightboxImage,
} from './ImageSurfaces'
import { toolResultImages, userMessageView } from './attachments'
import { stripAnsi } from '../../../../packages/shared/ansi'
import { messageText } from './transcript'
import { emptyActivity, elapsed, type Activity, type RunMetrics } from './activity'
import {
  projectTranscript,
  toolState,
  toolSummary,
  failureLabel,
  groupStatistics,
  type ThoughtRow,
  type ToolRow,
  type ProcessRow,
} from './presentation'

const Document = memo(Markdown)
const noActivity = emptyActivity()
const ActiveSurface = createContext(true)
// Stable native keys preserve expansion when streaming thinking moves into a new group.
const Disclosures = createContext<{ expanded: Record<string, boolean>; toggle: (key: string) => void }>({
  expanded: {},
  toggle: () => {},
})
function useDisclosure(key: string): [boolean, () => void] {
  const { expanded, toggle } = useContext(Disclosures)
  return [!!expanded[key], () => toggle(key)]
}
function useClock(active: boolean) {
  const foreground = useContext(ActiveSurface)
  active = active && foreground
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!active) return
    setNow(performance.now())
    const timer = setInterval(() => setNow(performance.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}
function Thinking({
  row,
  activity,
  groupOpen = true,
}: {
  row: ThoughtRow
  activity: Activity
  groupOpen?: boolean
}) {
  const [open, toggle] = useDisclosure(row.key)
  const timing = activity.thoughts[row.key]
  const running = !!timing && timing.ended === undefined
  const now = useClock(running)
  const visible = groupOpen || running || open
  const title = running
    ? `Thinking… ${elapsed(now - timing.started)}`
    : `Thought${timing ? ' ' + elapsed(timing.ended! - timing.started) : ''}`
  return (
    <div className="thinking-row process-row" hidden={!visible}>
      <button className="process-toggle" aria-expanded={open} onClick={toggle}>
        <ChevronRight size={14} className={open ? 'disclosure-open' : ''} />
        <Brain size={14} />
        <span>{title}</span>
      </button>
      {visible && open && (
        <div className="process-content">
          <Document text={row.text} />
        </div>
      )}
    </div>
  )
}
function Tool({
  row,
  results,
  activity,
  workspace,
  groupOpen,
}: {
  row: ToolRow
  results: Map<string, Message>
  activity: Activity
  workspace: string
  groupOpen: boolean
}) {
  const [open, toggle] = useDisclosure(row.key)
  const call = { ...row.call, arguments: activity.tools[row.call.id || '']?.args ?? row.call.arguments }
  const status = toolState(call, results, activity.tools)
  const visible = groupOpen || status === 'pending' || status === 'running'
  const result = results.get(row.call.id || '') || activity.tools[row.call.id || '']?.result
  const Icon =
    status === 'running'
      ? LoaderCircle
      : status === 'succeeded'
        ? Check
        : status === 'failed'
          ? CircleAlert
          : Circle
  const label = status === 'failed' ? failureLabel(result) : status
  const diff = useMemo(
    () => call.name === 'edit' && status === 'succeeded' ? countGroupDiff(result?.details?.diff) : undefined,
    [call.name, status, result?.details?.diff],
  )
  const written = useMemo(
    () => call.name === 'write' && status === 'succeeded' ? countContentLines((call.arguments as Record<string, unknown> | undefined)?.content) : undefined,
    [call.name, status, call.arguments],
  )
  return (
    <div className={`tool-row process-row tool-${status}`} hidden={!visible}>
      <button className="process-toggle tool-toggle" aria-expanded={open} onClick={toggle}>
        <ChevronRight size={14} className={open ? 'disclosure-open' : ''} />
        <strong>{row.call.name || 'tool'}</strong>
        <span className="tool-info">
          <span className="tool-summary">{toolSummary(call, workspace)}</span>
          {call.name === 'edit' && status === 'succeeded' && (diff ? (
            <span className="tool-call-changes" title="Native edit diff · this call only" aria-label={`${diff.added} ${diff.added === 1 ? 'line' : 'lines'} added, ${diff.removed} ${diff.removed === 1 ? 'line' : 'lines'} removed`}>
              <b className="tool-lines-added">+{diff.added}</b>
              <b className="tool-lines-removed">−{diff.removed}</b>
            </span>
          ) : <span className="tool-diff-missing">Diff unavailable</span>)}
          {written !== undefined && (
            <span className="tool-write-count" title="Submitted content length. Previous content unavailable; this is not a diff.">
              Written {written} {written === 1 ? 'line' : 'lines'}
            </span>
          )}
        </span>
        <span className={`tool-state state-${status}`}>
          <Icon size={13} className={status === 'running' ? 'spin' : ''} />
          {label}
        </span>
      </button>
      {visible && open && (
        <div className="tool-output process-content">
          {call.name === 'write' || call.name === 'edit' ? (
            <ToolChanges call={call} result={result} status={status} />
          ) : isWebTool(call.name) ? <WebToolResult name={call.name!} args={call.arguments || {}} result={result} status={status} /> : <>
          <div className="tool-section-label">Arguments</div>
          <pre>{JSON.stringify(call.arguments || {}, null, 2)}</pre>
          <div className="tool-section-label">{status === 'running' ? 'Live output' : 'Result'}</div>
          <pre className={status === 'failed' ? 'error-text' : ''}>
            {result
              ? boundedOutput(result)
              : status === 'pending'
                ? 'Waiting to execute…'
                : 'Waiting for output…'}
          </pre>
          </>}
        </div>
      )}
    </div>
  )
}
function boundedOutput(result: Message) {
  const text = stripAnsi(messageText(result))
  return (
    text.slice(0, 30000) +
    (text.length > 30000
      ? '\n… Output preview limited to 30,000 characters. Full output remains in the native session.'
      : '')
  )
}
function ToolGroup({
  rows,
  results,
  activity,
  workspace,
  onOpenImage,
}: {
  rows: ProcessRow[]
  results: Map<string, Message>
  activity: Activity
  workspace: string
  onOpenImage: (image: LightboxImage) => void
}) {
  const [open, toggle] = useDisclosure(`group:${rows.find((row) => row.kind === 'tool')!.key}`)
  const { expanded } = useContext(Disclosures)
  const [limit, setLimit] = useState(100)
  const calls = rows.filter((row): row is ToolRow => row.kind === 'tool').map((row) => row.call)
  const attention = (row: ProcessRow) =>
    row.kind === 'thought'
      ? !!expanded[row.key] ||
        (!!activity.thoughts[row.key] && activity.thoughts[row.key].ended === undefined)
      : ['pending', 'running'].includes(toolState(row.call, results, activity.tools))
  const children = rows.filter((row, index) => (open && index < limit) || attention(row))
  const allImages = toolResultImages(calls, results)
  const images = open
    ? toolResultImages(
        children.filter((row): row is ToolRow => row.kind === 'tool').map((row) => row.call),
        results,
      )
    : []
  const stats = groupStatistics(calls, results, activity.tools)
  return (
    <section className="tool-group" aria-label={`${calls.length} tool calls`}>
      <div className="tool-group-summary">
        <div className="tool-group-header">
          <button className="process-toggle tool-group-title" aria-expanded={open} onClick={toggle}>
            <ChevronRight size={14} className={open ? 'disclosure-open' : ''} />
            <Layers size={16} />
            <strong>
              {calls.length} tool {calls.length === 1 ? 'call' : 'calls'}
            </strong>
          </button>
          <div className="tool-group-status" aria-label="Tool execution status">
            {stats.states.succeeded === calls.length ? (
              <span className="status-badge state-succeeded">
                <Check size={12} />
                {calls.some(call => isWebTool(call.name)) ? 'Calls completed' : 'All succeeded'}
              </span>
            ) : (
              <>
                {stats.states.succeeded > 0 && (
                  <span className="status-badge state-succeeded">
                    <Check size={12} />
                    {stats.states.succeeded} succeeded
                  </span>
                )}
                {stats.states.failed > 0 && (
                  <span className="status-badge state-failed">
                    <CircleAlert size={12} />
                    {stats.states.failed} failed
                  </span>
                )}
                {stats.states.running > 0 && (
                  <span className="status-badge state-running">
                    <LoaderCircle size={12} className="spin" />
                    {stats.states.running} running
                  </span>
                )}
                {stats.states.pending > 0 && (
                  <span className="status-badge">
                    <Circle size={11} />
                    {stats.states.pending} pending
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="tool-group-tags" aria-label="Tool breakdown">
          {[...stats.tools].map(([name, count]) => (
            <span className="tool-tag" key={name}>
              <span>{name}</span>
              <span className="tool-tag-count">{count}</span>
            </span>
          ))}
          {!!allImages.length && (
            <span className="tool-tag" title="Image results from this group">
              <span>images</span>
              <span className="tool-tag-count">{allImages.length}</span>
            </span>
          )}
          {stats.tools.has('edit') && (
            <span className="tool-diff-tag" title="Cumulative successful edit diffs, not a Git net diff">
              <span>Changes</span>
              <b className="state-succeeded">+{stats.added}</b>
              <b className="state-failed">−{stats.removed}</b>
            </span>
          )}
          {stats.unavailable > 0 && (
            <span className="tool-diff-unavailable">
              {stats.unavailable} edit {stats.unavailable === 1 ? 'diff' : 'diffs'} unavailable
            </span>
          )}
        </div>
      </div>
      {open && <ToolImageGrid images={images} onOpen={onOpenImage} />}
      <div className="tool-group-children">
        {children.map((row) =>
          row.kind === 'tool' ? (
            <Tool
              key={row.key}
              row={row}
              results={results}
              activity={activity}
              workspace={workspace}
              groupOpen={open}
            />
          ) : (
            <Thinking key={row.key} row={row} activity={activity} groupOpen={open} />
          ),
        )}
        {open && rows.length > limit && (
          <button className="load-earlier" onClick={() => setLimit((n) => n + 100)}>
            Show more calls ({rows.length - limit})
          </button>
        )}
      </div>
    </section>
  )
}
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n))
function RunEnding({ metrics }: { metrics: RunMetrics }) {
  const tps =
    metrics.output !== undefined && metrics.output > 0 && metrics.generationMs > 0
      ? (metrics.output / (metrics.generationMs / 1000)).toFixed(1)
      : '—'
  return (
    <div className="run-metrics" aria-label="Response statistics">
      <span>
        <Clock3 size={13} />
        {elapsed(metrics.totalMs)}
      </span>
      <span title="Output tokens / summed model-turn time, including TTFT; excludes tool execution time">
        {tps} tok/s
      </span>
      {metrics.ttftMs !== undefined && <span>TTFT {(metrics.ttftMs / 1000).toFixed(1)}s</span>}
      {metrics.input !== undefined && <span>in {tokens(metrics.input)}</span>}
      {metrics.output !== undefined && <span>out {tokens(metrics.output)}</span>}
      {metrics.stallMs > 0 && (
        <span className="state-running">
          stall {metrics.stallCount}× / {(metrics.stallMs / 1000).toFixed(1)}s
        </span>
      )}
      {!!metrics.cost && !!metrics.totalTokens && (
        <span title="Effective cost per million total tokens, not total charge">
          rate ${((metrics.cost / metrics.totalTokens) * 1_000_000).toFixed(2)}/M
        </span>
      )}
    </div>
  )
}
function Working({ active }: { active?: Activity['active'] }) {
  const now = useClock(!!active)
  return (
    <div className="working" role="status">
      <LoaderCircle size={14} className="spin" />
      {active ? `${active.phase}… ${elapsed(now - active.started)}` : 'Pi is working'}
    </div>
  )
}
export const Conversation = memo(
  function Conversation({
    messages,
    busy,
    activity = noActivity,
    workspace = '',
    handle,
    active = true,
    modelProvider,
    onSubagentDraft,
    requestNavigation,
  }: {
    messages: Message[]
    busy: boolean
    activity?: Activity
    workspace?: string
    handle?: string
    active?: boolean
    modelProvider?: string
    onSubagentDraft?: (request: SupervisorRequest) => void
    requestNavigation?: { requestId: string; sequence: number }
  }) {
    const scroll = useRef<HTMLDivElement>(null)
    const follow = useRef(true)
    const [away, setAway] = useState(false)
    const [visible, setVisible] = useState(100)
    const [expanded, setExpanded] = useState<Record<string, boolean>>({})
    const [lightbox, setLightbox] = useState<LightboxImage>()
    const toggle = useCallback((key: string) => setExpanded((old) => ({ ...old, [key]: !old[key] })), [])
    const openImage = useCallback((image: LightboxImage) => setLightbox(image), [])
    const closeImage = useCallback(() => setLightbox(undefined), [])
    const disclosures = useMemo(() => ({ expanded, toggle }), [expanded, toggle])
    const results = useMemo(() => {
      const map = new Map<string, Message>()
      for (const [id, tool] of Object.entries(activity.tools))
        if (tool.result && ['succeeded', 'failed'].includes(tool.status)) map.set(id, tool.result)
      for (const message of messages)
        if (message.role === 'toolResult') map.set(message.toolCallId || '', message)
      return map
    }, [messages, activity.tools])
    // Paginate projected rows rather than cutting through a tool group or orphaning results.
    const rows = useMemo(() => projectTranscript(messages), [messages])
    const requestIds = useMemo(() => new Set(messages.flatMap(message => { const request = supervisorRequest(message); return request ? [request.requestId] : [] })), [messages])
    const [localNavigation, setLocalNavigation] = useState<{ requestId: string; sequence: number }>()
    const navigateRequest = (requestId: string) => setLocalNavigation(old => ({ requestId, sequence: (old?.sequence ?? 0) + 1 }))
    const [pendingRequest, setPendingRequest] = useState<string>()
    useEffect(() => { if (requestNavigation) setPendingRequest(requestNavigation.requestId) }, [requestNavigation])
    useEffect(() => { if (localNavigation) setPendingRequest(localNavigation.requestId) }, [localNavigation])
    useEffect(() => {
      if (!pendingRequest || !active) return
      const index = rows.findLastIndex(row => row.kind === 'message' && supervisorRequest(row.message)?.requestId === pendingRequest)
      if (index === -1) { setPendingRequest(undefined); return }
      follow.current = false
      if (rows.length - index > visible) { setVisible(rows.length - index); return }
      const target = [...(scroll.current?.querySelectorAll<HTMLElement>('[data-supervisor-request]') ?? [])].findLast(el => el.dataset.supervisorRequest === pendingRequest)
      target?.scrollIntoView?.({ block: 'center' }); target?.focus({ preventScroll: true })
      setPendingRequest(undefined)
    }, [pendingRequest, rows, visible, active])
    useEffect(() => {
      if (active && follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
    }, [messages, busy, activity.tools, activity.compaction, active])
    return (
      <ActiveSurface.Provider value={active}>
        <Disclosures.Provider value={disclosures}>
          <div className="conversation-wrap">
            <div
              ref={scroll}
              className="conversation"
              tabIndex={-1}
              aria-label="Conversation"
              onScroll={(e) => {
                if (!active) return
                const el = e.currentTarget
                follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
                setAway(!follow.current)
              }}
            >
              <div className="reading-column">
                {rows.length > visible && (
                  <button
                    className="load-earlier"
                    onClick={() => {
                      follow.current = false
                      setVisible((n) => n + 100)
                    }}
                  >
                    Show earlier messages ({rows.length - visible})
                  </button>
                )}
                {rows.slice(-visible).map((row) => {
                  if (row.kind === 'ending')
                    return activity.completed[row.messageKey] ? (
                      <RunEnding key={row.key} metrics={activity.completed[row.messageKey]} />
                    ) : null
                  if (row.kind === 'group')
                    return (
                      <ToolGroup
                        key={row.key}
                        rows={row.children}
                        results={results}
                        activity={activity}
                        workspace={workspace}
                        onOpenImage={openImage}
                      />
                    )
                  if (row.kind === 'thought') return <Thinking key={row.key} row={row} activity={activity} />
                  if (row.kind === 'tool') return null
                  if (row.kind === 'text')
                    return (
                      <article className="message assistant-message" key={row.key}>
                        <Document text={row.text} />
                      </article>
                    )
                  if (row.kind === 'notice')
                    return (
                      <div key={row.key} role="alert" className="inline-error">
                        {row.message.errorMessage ||
                          (row.message.stopReason === 'aborted'
                            ? 'Response stopped'
                            : 'Response ended before completion')}
                      </div>
                    )
                  if (row.message.role === 'desktopNotice') {
                    const text = messageText(row.message)
                    const level = row.message.details?.level || 'info'
                    return (
                      <aside
                        key={row.key}
                        className={`session-notice notice-${level}`}
                        role={level === 'error' ? 'alert' : 'status'}
                      >
                        <span className="notice-label">
                          {level === 'error' ? 'Error' : level === 'warning' ? 'Notice' : 'Session update'}
                        </span>
                        {text.length > 1200 ? (
                          <details>
                            <summary>{text.slice(0, 180)}…</summary>
                            <pre>{text}</pre>
                          </details>
                        ) : (
                          <p>{text}</p>
                        )}
                      </aside>
                    )
                  }
                  if (row.message.role === 'compactionSummary') {
                    if (activity.compaction?.result?.summary === row.message.summary) return null
                    return (
                      <CompactionNotice
                        key={row.key}
                        value={{
                          status: 'complete',
                          result: { summary: row.message.summary, tokensBefore: row.message.tokensBefore },
                          notices: [],
                        }}
                      />
                    )
                  }
                  const notice = subagentNotice(row.message)
                  if (notice) return <SubagentNotice key={row.key} message={row.message} view={notice} onDraft={onSubagentDraft} onRequest={navigateRequest} requestIds={requestIds} />
                  if (row.message.role === 'custom' && backgroundNotice(row.message)) {
                    return <WebBackgroundNotice key={row.key} message={row.message} />
                  }
                  if (row.message.role === 'custom' && row.message.customType === 'web-search-results') {
                    return <WebToolResult key={row.key} name="web_search" args={{}} result={row.message} status={row.message.isError || row.message.details?.error ? 'failed' : 'succeeded'} />
                  }
                  const user = row.message.role === 'user'
                  const view = user ? userMessageView(row.message) : undefined
                  const text = view?.text ?? messageText(row.message)
                  return (
                    <article
                      key={row.key}
                      className={`message ${user ? 'user-message' : 'assistant-message'}`}
                    >
                      {text && (user ? <div className="user-bubble">{text}</div> : <Document text={text} />)}
                      {view && (
                        <UserAttachments
                          images={view.images}
                          files={view.files}
                          handle={handle}
                          onOpen={openImage}
                        />
                      )}
                      {!user &&
                        Array.isArray(row.message.content) &&
                        row.message.content.some((b) => b.type === 'image') && (
                          <small className="muted">Image attachment retained in Pi session</small>
                        )}
                    </article>
                  )
                })}
                {activity.compaction && (
                  <CompactionNotice value={activity.compaction} modelProvider={modelProvider} />
                )}
                {(busy || activity.active) && activity.compaction?.status !== 'running' && (
                  <Working active={activity.active} />
                )}
              </div>
            </div>
            {away && (
              <button
                className="jump-bottom icon-button"
                title="Jump to latest"
                aria-label="Jump to latest"
                onClick={() => {
                  follow.current = true
                  scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' })
                }}
              >
                <ArrowDown size={17} />
              </button>
            )}
          </div>
          <ImageLightbox item={lightbox} onClose={closeImage} />
        </Disclosures.Provider>
      </ActiveSurface.Provider>
    )
  },
  (previous, next) => previous.active === false && next.active === false,
)
