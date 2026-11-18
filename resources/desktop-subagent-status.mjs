import { randomUUID } from 'node:crypto'

// Optional, read-only bridge to pi-subagents' public v1 status API. Never imports
// plugin internals, starts children, reads artifacts or writes session history.
export const STATUS_WIDGET = '__pi_desktop_subagents_v1__'
const text = (value, max = 512) => typeof value === 'string'
  ? value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : undefined
const time = value => Number.isFinite(value) && value >= 0 ? value : undefined
const states = { running: 'running', queued: 'queued', pending: 'queued', complete: 'complete', completed: 'complete', failed: 'failed', partial: 'failed', rejected: 'failed', paused: 'paused', stopped: 'stopped' }
const terminal = state => ['complete', 'failed', 'stopped', 'paused', 'unknown'].includes(state)

export function createSubagentProjection() {
  let asyncCards = [], omitted = 0
  const foreground = new Map(), calls = new Map(), endTimes = new Map(), asyncTasks = new Map()
  function stamp(card, now) {
    if (terminal(card.state)) {
      if (endTimes.get(card.id)?.state !== card.state) endTimes.set(card.id, { state: card.state, time: card.endedAt ?? now })
      card.endedAt = endTimes.get(card.id).time
    } else endTimes.delete(card.id)
    return card
  }
  function acceptSnapshot(snapshot, now = Date.now()) {
    if (snapshot?.kind !== 'pi-subagents.async-status-snapshot' || snapshot.version !== 1 || !Array.isArray(snapshot.runs)) return false
    const cards = [], seen = new Set()
    function visit(node, parent, root, depth = 0) {
      if (!node || depth > 4 || cards.length >= 128 || node.kind === 'host-step' || typeof node.id !== 'string') return
      const id = parent ? `${parent}/${text(node.id, 200)}` : `async:${text(node.id, 200)}`
      if (seen.has(id)) return
      seen.add(id)
      const children = Array.isArray(node.children) ? node.children.filter(c => c?.kind !== 'host-step') : []
      // Child snapshots already deduplicate materialized workflow lanes. Do not
      // repeat successful/running orchestration wrappers as additional workers.
      if (children.length && !['failed', 'partial', 'rejected', 'paused'].includes(node.state)) {
        for (const child of children.slice(0, 64)) visit(child, id, root, depth + 1)
        return
      }
      const activity = node.activity || {}
      const waiting = ['waiting', 'waiting_for_user', 'waiting_for_supervisor', 'needs_attention', 'awaiting_supervisor'].includes(activity.state)
      const state = waiting && node.state === 'running' ? 'waiting' : states[node.state]
      if (!state) return
      const card = stamp({ id, name: text(node.agent || node.label, 100) || 'Subagent',
        state, model: text(node.model, 160), thinking: text(node.thinking, 30),
        task: asyncTasks.get(root.id) || (node.agent && node.label !== node.agent ? text(node.label) : undefined),
        startedAt: time(node.startedAt) ?? time(root.startedAt), endedAt: time(node.endedAt),
        activity: [text(activity.state, 80), text(activity.currentTool, 120), Number.isFinite(activity.toolCount) ? `${activity.toolCount} tools` : undefined].filter(Boolean).join(' · ') || undefined,
        parentId: parent,
      }, now)
      cards.push(card)
      for (const child of children.slice(0, 64)) visit(child, id, root, depth + 1)
    }
    for (const run of snapshot.runs.slice(0, 128)) visit(run, undefined, run)
    asyncCards = cards
    omitted = Object.values(snapshot.omitted || {}).filter(Number.isFinite).reduce((a, b) => a + Math.max(0, b), 0)
    return true
  }
  function tool(event, now = Date.now()) {
    if (event.toolName !== 'subagent' || typeof event.toolCallId !== 'string') return false
    const key = event.toolCallId
    if (event.type === 'tool_execution_start') {
      // Hold authored input privately until native payload proves foreground.
      if (calls.size >= 128) calls.delete(calls.keys().next().value)
      calls.set(key, { task: text(event.args?.task), runId: undefined })
      return false
    }
    const final = event.type === 'tool_execution_end'
    const lostFinal = () => {
      const call = calls.get(key)
      let changed = false
      for (const [id, card] of foreground) {
        if (id.startsWith(`foreground:${call?.runId || key}:`) && !terminal(card.state)) {
          // The native tool failed, but this does not prove a detached child exited.
          foreground.set(id, stamp({ ...card, state: 'unknown', endedAt: now,
            activity: event.isError ? 'Delegation failed; child status unavailable' : 'Final child status unavailable' }, now))
          changed = true
        }
      }
      calls.delete(key)
      return changed
    }
    const details = (final ? event.result : event.partialResult)?.details
    if (!details || details.mode !== 'single' || details.asyncId || details.asyncDir || !Array.isArray(details.results)) {
      if (details?.mode === 'single' && typeof details.asyncId === 'string' && calls.get(key)?.task) {
        if (asyncTasks.size >= 128) asyncTasks.delete(asyncTasks.keys().next().value)
        asyncTasks.set(details.asyncId, calls.get(key).task)
      }
      return final ? lostFinal() : false
    }
    const call = calls.get(key) || {}
    const runId = text(details.runId, 200) || call.runId || key
    call.runId = runId
    calls.set(key, call)
    let changed = false
    for (const result of details.results.slice(0, 64)) {
      if (!result || !Number.isInteger(result.index) || typeof result.agent !== 'string') continue
      const id = `foreground:${runId}:${result.index}`, previous = foreground.get(id)
      const progress = result.progress || (Array.isArray(details.progress) ? details.progress.find(p => p.index === result.index) : undefined) || {}
      let state = states[progress.status] || 'running'
      if (state === 'running' && progress.activityState === 'needs_attention') state = 'waiting'
      if (final) {
        state = result.detached ? 'running' : result.interrupted ? 'paused' : result.stopped ? 'stopped'
          : result.timedOut || result.turnBudgetExceeded || result.error || (result.acceptance?.explicit && result.acceptance.status === 'rejected') || event.isError || result.exitCode !== 0 ? 'failed' : 'complete'
      }
      const duration = time(final ? result.progressSummary?.durationMs : progress.durationMs)
      const card = stamp({ id, name: text(result.agent, 100), state,
        task: call.task || previous?.task,
        model: text(result.model || progress.model, 160) || previous?.model,
        thinking: text(result.thinking || progress.thinking, 30) || previous?.thinking,
        startedAt: final && duration !== undefined ? now - duration : previous?.startedAt ?? (duration !== undefined ? now - duration : undefined),
        endedAt: terminal(state) ? now : undefined,
        activity: [text(progress.currentTool, 120), Number.isFinite(progress.toolCount) ? `${progress.toolCount} tools` : undefined,
          final && terminal(state) ? state === 'complete' ? 'Result in conversation' : text(result.error, 200) || state : undefined].filter(Boolean).join(' · ') || previous?.activity,
      }, now)
      foreground.set(id, card); changed = true
    }
    if (final && !changed) return lostFinal()
    if (final) calls.delete(key)
    return changed
  }
  function detached(event, now = Date.now()) {
    const id = `foreground:${event?.runId}:${event?.taskIndex}`
    const card = foreground.get(id)
    if (!card || event.source !== 'foreground') return false
    const state = event.interrupted ? 'paused' : event.stopped ? 'stopped' : event.success ? 'complete' : 'failed'
    foreground.set(id, stamp({ ...card, state, endedAt: time(event.timestamp) ?? now,
      activity: state === 'complete' ? 'Result in conversation' : state === 'failed' ? 'Delegation failed' : state }, now))
    return true
  }
  function snapshot(now = Date.now()) {
    for (const [id, card] of foreground) if (card.state === 'complete' && now - card.endedAt >= 10000) foreground.delete(id)
    // Bound retained attention rows too; no session-wide growth during long runs.
    while (foreground.size > 128) foreground.delete(foreground.keys().next().value)
    const agents = [...asyncCards, ...foreground.values()].filter(c => c.state !== 'complete' || now - c.endedAt < 10000)
    const keep = new Set([...asyncCards, ...foreground.values()].map(c => c.id))
    for (const id of endTimes.keys()) if (!keep.has(id)) endTimes.delete(id)
    return { availability: 'available', agents: agents.slice(0, 128), updatedAt: now, omitted: omitted + Math.max(0, agents.length - 128) }
  }
  return { acceptSnapshot, tool, detached, snapshot }
}

export function bindSubagentStatus(pi) {
  const projection = createSubagentProjection()
  let ctx, ready = false, stopped = false, inFlight = false, timer, lastKey = '', cancelRequest
  const offs = []
  const publish = error => {
    if (!ctx || stopped) return
    const status = projection.snapshot()
    if (error) status.error = error
    const key = JSON.stringify({ ...status, updatedAt: 0 })
    if (lastKey !== key) { lastKey = key; ctx.ui.setWidget(STATUS_WIDGET, [JSON.stringify(status)]) }
  }
  const schedule = () => {
    if (stopped || !ctx || !ready || timer) return
    timer = setTimeout(() => { timer = undefined; void refresh() }, 500)
    timer.unref?.()
  }
  const requestStatus = () => new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, reply => {
      cleanup()
      reply?.success ? resolve(reply.data) : reject(new Error('Native status unavailable'))
    })
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Native status timed out')) }, 1500)
    const cleanup = () => { clearTimeout(timeout); off(); cancelRequest = undefined }
    cancelRequest = () => { cleanup(); reject(new Error('Session closed')) }
    pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method: 'status' })
  })
  async function refresh() {
    if (!ready || !ctx || stopped || inFlight) return
    inFlight = true
    try {
      const data = await requestStatus()
      if (stopped) return
      if (!projection.acceptSnapshot(data?.asyncSnapshot)) throw new Error('Unsupported native status format')
      publish()
    } catch (error) { if (!stopped) publish(error.message) }
    finally {
      inFlight = false
      if (!stopped && projection.snapshot().agents.some(a => ['running', 'queued', 'waiting', 'complete'].includes(a.state))) {
        timer ||= setTimeout(() => { timer = undefined; void refresh() }, 2000)
        timer.unref?.()
      }
    }
  }
  offs.push(pi.events.on('subagents:rpc:v1:ready', event => {
    // Older plugin status may execute an artifact scan. Only poll the public,
    // bounded in-memory projection supported by this version.
    ready = event?.version === 1 && event.capabilities?.statusProjection?.untargeted === 'in-memory-when-ready'
    schedule()
  }))
  for (const event of ['subagent:jobs-changed', 'subagent:async-started', 'subagent:async-complete', 'subagent:child-status']) offs.push(pi.events.on(event, schedule))
  offs.push(pi.events.on('subagent:foreground-complete', event => {
    if (ready && ctx && event?.sessionId === ctx.sessionManager.getSessionId() && projection.detached(event)) publish()
  }))
  for (const type of ['tool_execution_start', 'tool_execution_update', 'tool_execution_end']) pi.on(type, event => {
    if (!ready || stopped) return
    if (projection.tool({ ...event, type })) publish()
    if (event.toolName === 'subagent') schedule()
  })
  pi.on('session_start', (_event, context) => { if (context.mode === 'rpc') { ctx = context; schedule() } })
  pi.on('session_shutdown', () => {
    stopped = true; clearTimeout(timer); cancelRequest?.(); for (const off of offs) off(); ctx = undefined
  })
}
