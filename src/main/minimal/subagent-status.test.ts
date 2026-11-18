import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { parseSubagentStatus } from '../../../packages/shared/subagents'
// @ts-expect-error Native ESM resource stays unbundled.
import { createSubagentProjection, bindSubagentStatus } from '../../../resources/desktop-subagent-status.mjs'
afterEach(() => vi.useRealTimers())
const snapshot = (runs: any[]) => ({ kind: 'pi-subagents.async-status-snapshot', version: 1, runs })
it('projects workflow leaves once, retains resolved models and freezes terminal timestamps', () => {
  const p = createSubagentProjection()
  p.acceptSnapshot(snapshot([{ id: 'w', kind: 'workflow', state: 'running', startedAt: 100, children: [
    { id: 'a', kind: 'step', label: 'Audit', agent: 'scout', state: 'running', model: 'p/model', thinking: 'high', activity: { currentTool: 'read', toolCount: 4 } },
    { id: 'b', kind: 'step', label: 'Review', agent: 'reviewer', state: 'queued' },
    { id: 'host', kind: 'host-step', state: 'running' },
  ] }]), 1000)
  expect(p.snapshot(1000).agents).toHaveLength(2)
  expect(p.snapshot(1000).agents[0]).toMatchObject({ id: 'async:w/a', name: 'scout', model: 'p/model', thinking: 'high', task: 'Audit', activity: 'read · 4 tools' })
  const run = { id: 'a', kind: 'subagent', label: 'scout', state: 'complete', startedAt: 100 }
  p.acceptSnapshot(snapshot([run]), 2000)
  p.acceptSnapshot(snapshot([run]), 4000)
  expect(p.snapshot(4000).agents[0].endedAt).toBe(2000)
  expect(p.snapshot(12000).agents).toHaveLength(0)
})
it('does not mistake async receipts, approval-only tools or wrappers for foreground workers', () => {
  const p = createSubagentProjection()
  p.tool({ type: 'tool_execution_start', toolName: 'subagent', toolCallId: 'c', args: { task: 'Authored task' } })
  p.tool({ type: 'tool_execution_end', toolName: 'subagent', toolCallId: 'c', result: { details: { mode: 'single', asyncId: 'r', results: [] } } })
  p.tool({ type: 'tool_execution_update', toolName: 'subagent_launch', toolCallId: 'a', partialResult: { details: { mode: 'single', results: [{ index: 0, agent: 'bad' }] } } })
  expect(p.snapshot().agents).toHaveLength(0)
  p.acceptSnapshot(snapshot([{ id: 'r', state: 'running', kind: 'subagent', label: 'scout' }]))
  expect(p.snapshot().agents[0].task).toBe('Authored task')
})
it('keys concurrent foreground children by run/index and respects interruption before exit code', () => {
  const p = createSubagentProjection()
  for (const run of ['A', 'B']) {
    p.tool({ type: 'tool_execution_start', toolName: 'subagent', toolCallId: run, args: { task: `Task ${run}` } }, 1000)
    p.tool({ type: 'tool_execution_update', toolName: 'subagent', toolCallId: run, partialResult: { details: { mode: 'single', runId: run, results: [{ index: 0, agent: 'scout', model: 'model', thinking: 'high', progress: { status: 'running', durationMs: 500 } }] } } }, 2000)
  }
  expect(p.snapshot(2000).agents.map((a: any) => a.id)).toEqual(['foreground:A:0', 'foreground:B:0'])
  p.tool({ type: 'tool_execution_end', toolName: 'subagent', toolCallId: 'A', result: { details: { mode: 'single', runId: 'A', results: [{ index: 0, agent: 'scout', interrupted: true, exitCode: 0, progressSummary: { durationMs: 900 } }] } } }, 2400)
  expect(p.snapshot(2400).agents[0]).toMatchObject({ state: 'paused', task: 'Task A', model: 'model', thinking: 'high', endedAt: 2400, startedAt: 1500 })
})
it('marks foreground attention and error-only termination without inventing child exit', () => {
  const p = createSubagentProjection()
  p.tool({ type: 'tool_execution_start', toolName: 'subagent', toolCallId: 'c', args: { task: 'Check' } }, 100)
  p.tool({ type: 'tool_execution_update', toolName: 'subagent', toolCallId: 'c', partialResult: { details: { mode: 'single', runId: 'r', results: [{ index: 0, agent: 'scout', progress: { status: 'running', activityState: 'needs_attention', durationMs: 500 } }] } } }, 1000)
  expect(p.snapshot(1000).agents[0].state).toBe('waiting')
  p.tool({ type: 'tool_execution_end', toolName: 'subagent', toolCallId: 'c', isError: true, result: { content: [{ type: 'text', text: 'Failed' }] } }, 1200)
  expect(p.snapshot(20000).agents[0]).toMatchObject({ state: 'unknown', endedAt: 1200, activity: 'Delegation failed; child status unavailable' })
  p.detached({ runId: 'r', taskIndex: 0, source: 'foreground', success: true, timestamp: 20000 }, 20000)
  expect(p.snapshot(20000).agents[0]).toMatchObject({ state: 'complete', endedAt: 20000, activity: 'Result in conversation' })
  expect(p.snapshot(29999).agents).toHaveLength(1)
  expect(p.snapshot(30000).agents).toHaveLength(0)
})
it('does not turn an optional attestation rejection into native execution failure', () => {
  const p = createSubagentProjection()
  p.tool({ type: 'tool_execution_end', toolName: 'subagent', toolCallId: 'c', result: { details: { mode: 'single', results: [{ index: 0, agent: 'scout', exitCode: 0, acceptance: { explicit: false, status: 'rejected' } }] } } }, 1000)
  expect(p.snapshot(1000).agents[0].state).toBe('complete')
})
it('rejects malformed and oversized bridge payloads', () => {
  expect(parseSubagentStatus('bad')).toBeUndefined()
  expect(parseSubagentStatus('x'.repeat(300000))).toBeUndefined()
  expect(parseSubagentStatus(JSON.stringify({ availability: 'available', agents: [{ id: 'x', name: 'x', state: 'invented' }] }))?.agents).toEqual([])
})
it('only polls an advertised in-memory API after session start and disposes listeners/timers', async () => {
  vi.useFakeTimers()
  const bus = new EventEmitter(), hooks = new Map<string, Function[]>(), widgets: any[] = [], requests: any[] = []
  const pi = {
    events: { on: (name: string, fn: any) => { bus.on(name, fn); return () => bus.off(name, fn) }, emit: (name: string, value: any) => bus.emit(name, value) },
    on: (name: string, fn: Function) => hooks.set(name, [...(hooks.get(name) || []), fn]),
  }
  const emit = async (name: string, ...args: any[]) => { for (const fn of hooks.get(name) || []) await fn(...args) }
  bindSubagentStatus(pi)
  bus.on('subagents:rpc:v1:request', request => { requests.push(request); bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true, data: { asyncSnapshot: snapshot([]) } }) })
  bus.emit('subagents:rpc:v1:ready', { version: 1, capabilities: { statusProjection: { untargeted: 'in-memory-when-ready' } } })
  await vi.advanceTimersByTimeAsync(1000)
  expect(requests).toHaveLength(0)
  await emit('session_start', {}, { mode: 'rpc', ui: { setWidget: (...args: any[]) => widgets.push(args) }, sessionManager: { getSessionId: () => 'owner' } })
  await vi.advanceTimersByTimeAsync(500)
  expect(requests).toHaveLength(1)
  expect(widgets).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(10000)
  expect(requests).toHaveLength(1) // no idle background polling
  await emit('session_shutdown', { reason: 'reload' })
  bus.emit('subagent:jobs-changed')
  await vi.advanceTimersByTimeAsync(10000)
  expect(requests).toHaveLength(1)
  expect(bus.listenerCount('subagent:jobs-changed')).toBe(0)
})
