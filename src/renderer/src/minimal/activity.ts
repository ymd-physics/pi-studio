import type { Message, PiRecord } from '../../../../packages/shared/desktop'
import { messageKey, type ToolState } from './presentation'
import { applyMessageEvent } from './transcript'
import { stripAnsi } from '../../../../packages/shared/ansi'

export interface CompactionActivity {
  started?: number
  ended?: number
  status: 'running' | 'complete' | 'cancelled' | 'failed' | 'handled'
  reason?: string
  error?: string
  engine?: 'openai-codex'
  native?: boolean
  failedByEngine?: boolean
  result?: {
    summary?: string
    tokensBefore?: number
    estimatedTokensAfter?: number
    details?: { kind?: string }
  }
  notices: { key: string; text: string; error: boolean }[]
}

export interface RunMetrics {
  totalMs: number
  generationMs: number
  ttftMs?: number
  input?: number
  output?: number
  totalTokens?: number
  cost?: number
  stallMs: number
  stallCount: number
}
export interface Activity {
  compaction?: CompactionActivity
  active?: { started: number; phase: string }
  thoughts: Record<string, { started: number; ended?: number }>
  tools: Record<string, { status: ToolState; result?: Message; args?: unknown }>
  completed: Record<string, RunMetrics>
}
export const emptyActivity = (): Activity => ({ thoughts: {}, tools: {}, completed: {} })
export function elapsed(ms: number, t?: ReturnType<typeof import('../../../../packages/shared/language').uiText>): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60), rest = String(seconds % 60).padStart(2, '0')
  return seconds < 60
    ? t?.('{seconds}s', { seconds }) ?? `${seconds}s`
    : t?.('{minutes}m {seconds}s', { minutes, seconds: rest }) ?? `${minutes}m ${rest}s`
}

/** UI-local, monotonic measurements. Same accounting as pi-deepseek-tui telemetry:
 * throughput = output / sum(turn_start → assistant message_end), NOT wall time minus TTFT.
 * Tool time is included in wall time, excluded from throughput. agent_end is not settlement.
 */
export class ActivityTracker {
  private state = emptyActivity()
  private run?: RunMetrics
  private agentStarted = false
  private lastAssistant?: string
  private turn?: { started: number; first?: number; ended?: number; lastDelta?: number; inStall: boolean }
  private seen = new Set<string>()
  private streaming?: Message
  private streamingKey?: string
  private occurrences = new Map<string, number>()
  constructor(private now: () => number = () => performance.now()) {}
  view(): Activity {
    return {
      ...this.state,
      thoughts: { ...this.state.thoughts },
      tools: { ...this.state.tools },
      completed: { ...this.state.completed },
    }
  }
  reset() {
    this.state = emptyActivity()
    this.run = undefined
    this.turn = undefined
    this.lastAssistant = undefined
    this.agentStarted = false
    this.streaming = undefined
    this.streamingKey = undefined
    this.occurrences.clear()
    this.seen.clear()
    return this.view()
  }
  dispatch() {
    if (!this.state.active) {
      this.state.active = { started: this.now(), phase: 'Working' }
      this.run = { totalMs: 0, generationMs: 0, stallMs: 0, stallCount: 0 }
      this.agentStarted = false
      this.lastAssistant = undefined
      this.turn = undefined
      this.seen.clear()
    }
    return this.view()
  }
  handled() {
    // An extension/input hook handled the command without starting an agent loop.
    if (!this.agentStarted) {
      this.state.active = undefined
      this.run = undefined
    }
    return this.view()
  }
  private closeTurn() {
    if (this.turn?.first !== undefined && this.turn.ended !== undefined && this.run)
      this.run.generationMs += Math.max(0, this.turn.ended - this.turn.started)
    this.turn = undefined
  }
  private finish() {
    this.closeTurn()
    const now = this.now()
    if (this.state.active && this.run && this.lastAssistant) {
      this.run.totalMs = now - this.state.active.started
      this.state.completed[this.lastAssistant] = { ...this.run }
    }
    for (const [key, timing] of Object.entries(this.state.thoughts)) {
      if (timing.ended === undefined) this.state.thoughts[key] = { ...timing, ended: now }
    }
    // Interrupted native calls must not leave permanent running spinners. UI only.
    for (const [id, tool] of Object.entries(this.state.tools)) {
      if (tool.status === 'pending' || tool.status === 'running')
        this.state.tools[id] = {
          ...tool,
          status: 'failed',
          result: {
            role: 'toolResult',
            isError: true,
            content: 'Execution ended without a result (cancelled or interrupted).',
          },
        }
    }
    this.state.active = undefined
    this.run = undefined
    this.agentStarted = false
  }
  handle(event: PiRecord, publish = true): Activity {
    const now = this.now()
    if (event.type === 'agent_start') {
      if (this.state.compaction?.status !== 'running') this.state.compaction = undefined
      this.dispatch()
      this.agentStarted = true
    }
    if (event.type === 'turn_start') {
      this.closeTurn()
      this.turn = { started: now, inStall: false }
      if (this.state.active) this.state.active = { ...this.state.active, phase: 'Working' }
    }
    const compactStart = [
      'compaction_start',
      'auto_compaction_start',
      'desktop_compaction_command_start',
    ].includes(event.type)
    const compactEnd = ['compaction_end', 'auto_compaction_end'].includes(event.type)
    if (compactStart) {
      const previous = this.state.compaction?.status === 'running' ? this.state.compaction : undefined
      this.state.compaction = {
        started: previous?.started ?? now,
        status: 'running',
        native: previous?.native || event.type !== 'desktop_compaction_command_start',
        engine: previous?.engine,
        reason: event.reason || previous?.reason,
        notices: previous?.notices || [],
      }
    }
    // Electron invoke replies may overtake event IPC. Once native start was seen,
    // wait for native end so intervening extension completion notices are not dropped.
    if (
      compactEnd ||
      (event.type === 'desktop_compaction_command_end' &&
        this.state.compaction?.status === 'running' &&
        !this.state.compaction.native)
    ) {
      const previous = this.state.compaction
      this.state.compaction = {
        started: previous?.started,
        ended: now,
        reason: event.reason || previous?.reason,
        status: previous?.failedByEngine
          ? 'failed'
          : event.aborted
            ? 'cancelled'
            : event.errorMessage || event.error
              ? 'failed'
              : event.result
                ? 'complete'
                : 'handled',
        result: event.result,
        engine:
          event.result?.details?.kind === 'openai-codex-native-compaction'
            ? 'openai-codex'
            : previous?.engine,
        error: event.errorMessage || event.error,
        notices: previous?.notices || [],
      }
    }
    if (event.type === 'desktop_error' && this.state.compaction?.status === 'running')
      this.state.compaction = {
        ...this.state.compaction,
        status: 'failed',
        ended: now,
        error: event.message || 'Pi disconnected during compaction',
      }
    if (
      event.type === 'extension_ui_request' &&
      this.state.compaction?.status === 'running' &&
      ['notify', 'setStatus'].includes(event.method)
    ) {
      const raw = event.method === 'notify' ? event.message : event.statusText
      if (typeof raw === 'string' && raw.trim()) {
        const previous = this.state.compaction
        const key =
          event.method === 'setStatus'
            ? `status:${event.statusKey}`
            : `notify:${now}:${previous.notices.length}`
        const notice = { key, text: stripAnsi(raw), error: event.notifyType === 'error' }
        this.state.compaction = {
          ...previous,
          failedByEngine:
            previous.failedByEngine ||
            (event.statusKey === 'pi-desktop-openai-compaction' &&
              raw === 'OpenAI Codex · Compaction failed'),
          engine: event.statusKey === 'pi-desktop-openai-compaction' ? 'openai-codex' : previous.engine,
          notices: [...previous.notices.filter((n) => n.key !== key), notice].slice(-32),
        }
      }
    }
    if (event.type === 'auto_retry_start' || compactStart) {
      if (this.state.active)
        this.state.active = {
          ...this.state.active,
          phase: event.type === 'auto_retry_start' ? 'Retrying' : 'Compacting',
        }
    }
    if (event.type === 'auto_retry_end' || compactEnd) {
      if (this.state.active) this.state.active = { ...this.state.active, phase: 'Working' }
    }
    // Pi 1.5 RPC strips message/partial from updates: rebuild the active assistant
    // using the same native delta reducer as the transcript before observing clocks.
    if (event.type === 'message_start' && event.message?.role === 'assistant') {
      this.streaming = event.message
      const base = messageKey(event.message)
      const occurrence = this.occurrences.get(base) || 0
      this.occurrences.set(base, occurrence + 1)
      this.streamingKey = occurrence ? `${base}#${occurrence}` : base
    }
    if (event.type === 'message_update')
      this.streaming = applyMessageEvent(this.streaming ? [this.streaming] : [], event)[0]
    const message = (event.message || (event.type === 'message_update' ? this.streaming : undefined)) as
      Message | undefined
    if (
      message?.role === 'assistant' &&
      ['message_start', 'message_update', 'message_end'].includes(event.type)
    ) {
      const key =
        this.streaming?.timestamp === message.timestamp && this.streamingKey
          ? this.streamingKey
          : messageKey(message)
      this.lastAssistant = key
      const blocks = Array.isArray(message.content) ? message.content : []
      for (const block of blocks)
        if (block?.type === 'toolCall' && block.id && !this.state.tools[block.id])
          this.state.tools[block.id] = { status: 'pending' }
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i]?.type !== 'thinking') continue
        const start = i
        while (blocks[i + 1]?.type === 'thinking') i++
        const generating = event.type !== 'message_end' && i === blocks.length - 1
        const thoughtKey = `${key}:thinking:${start}`
        const timing = this.state.thoughts[thoughtKey]
        if (!timing && generating) this.state.thoughts[thoughtKey] = { started: now }
        if (timing && timing.ended === undefined && !generating)
          this.state.thoughts[thoughtKey] = { ...timing, ended: now }
      }
      const stream = event.assistantMessageEvent
      if (event.type === 'message_start' && this.turn) {
        this.turn.lastDelta = undefined
        this.turn.inStall = false
      }
      if (
        event.type === 'message_update' &&
        /^(text|thinking|toolcall)_delta$/.test(stream?.type) &&
        stream.delta?.length &&
        this.turn &&
        this.run
      ) {
        const wall = Date.now()
        const arrival = (stamp: unknown) => typeof stamp === 'number' ? Math.max(this.turn!.started, now - Math.max(0, wall-stamp)) : now
        const first = arrival(event.desktopFirstDelta), last = arrival(event.desktopLastDelta)
        this.turn.first ??= first
        this.run.ttftMs ??= this.turn.first - this.turn.started
        if (this.turn.lastDelta !== undefined) {
          const gap = first - this.turn.lastDelta
          if (gap >= 1000) {
            this.run.stallMs += gap
            if (!this.turn.inStall) this.run.stallCount++
            this.turn.inStall = true
          } else this.turn.inStall = false
        }
        if (last > first) this.turn.inStall = false
        this.turn.lastDelta = last
      }
      if (event.type === 'message_end' && this.run && !this.seen.has(key)) {
        this.seen.add(key)
        if (this.turn) this.turn.ended = now
        const usage = message.usage
        if (usage && [usage.input, usage.output, usage.totalTokens].every(Number.isFinite)) {
          this.run.input = (this.run.input || 0) + usage.input
          this.run.output = (this.run.output || 0) + usage.output
          this.run.totalTokens = (this.run.totalTokens || 0) + usage.totalTokens
          if (Number.isFinite(usage.cost?.total)) this.run.cost = (this.run.cost || 0) + usage.cost!.total
          if (usage.output > 0 && this.turn) {
            this.turn.first ??= now
            this.run.ttftMs ??= now - this.turn.started
          }
        }
      }
    }
    if (event.type.startsWith('tool_execution_') && event.toolCallId) {
      const old = this.state.tools[event.toolCallId]
      const result = event.result || event.partialResult
      this.state.tools[event.toolCallId] = {
        status: event.type === 'tool_execution_end' ? (event.isError ? 'failed' : 'succeeded') : 'running',
        result: result
          ? { ...result, role: 'toolResult', toolCallId: event.toolCallId, isError: event.isError === true }
          : old?.result,
        args: event.args ?? old?.args,
      }
    }
    if (event.type === 'turn_end') this.closeTurn()
    if (event.type === 'agent_settled' || event.type === 'desktop_error') this.finish()
    return publish ? this.view() : this.state
  }
}
