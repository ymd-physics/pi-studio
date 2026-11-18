import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
// @ts-expect-error Packaged ESM resource is deliberately not compiled by TypeScript.
import { bindSubagentShutdown } from '../../../resources/desktop-subagents.mjs'
// @ts-expect-error Packaged ESM resource is deliberately not compiled by TypeScript.
import { startDesktopRpc } from '../../../resources/desktop-rpc.mjs'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

it('pins both host-discovery roots before importing the selected SDK', async () => {
  vi.stubEnv('PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT', '/wrong/parent')
  vi.stubEnv('PI_PACKAGE_DIR', '/wrong/assets')
  await expect(startDesktopRpc('/nonexistent-selected-pi/dist/index.js', '/unused-session')).rejects.toThrow()
  expect(process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT).toBe('/nonexistent-selected-pi')
  expect(process.env.PI_PACKAGE_DIR).toBe('/nonexistent-selected-pi')
})

function fixture() {
  const events = new EventEmitter()
  const handlers = new Map<string, (e: any) => Promise<void>>()
  const requests: any[] = []
  const status = { asyncSnapshot: { runs: [
    { id: 'restored', state: 'running' }, { id: 'finished', state: 'complete' },
  ] } }
  const pi = {
    events: {
      on: (event: string, listener: (...args: any[]) => void) => { events.on(event, listener); return () => events.off(event, listener) },
      emit: (event: string, value: any) => events.emit(event, value),
    },
    on: (event: string, handler: (e: any) => Promise<void>) => handlers.set(event, handler),
  }
  events.on('subagents:rpc:v1:request', (request) => {
    requests.push(request)
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      success: true, data: request.method === 'status' ? status : { state: 'stopping' },
    })
  })
  bindSubagentShutdown(pi)
  return { events, requests, quit: (reason = 'quit') => handlers.get('session_shutdown')!({ reason }) }
}

it('does nothing without the optional plugin or on native in-process reload', async () => {
  const f = fixture()
  await f.quit()
  f.events.emit('subagents:rpc:v1:ready', { version: 1 })
  await f.quit('reload')
  expect(f.requests).toHaveLength(0)
})

it('stops restored active jobs and all observed launches, not just the bounded status window', async () => {
  const f = fixture()
  f.events.emit('subagents:rpc:v1:ready', { version: 1 })
  for (let i = 0; i < 30; i++) f.events.emit('subagent:async-started', { id: `owned-${i}` })
  f.events.emit('subagent:process-terminal', { runId: 'owned-0', state: 'observed' })
  await f.quit()
  const targets = f.requests.filter(r => r.method === 'stop').map(r => r.params.id)
  expect(targets).toHaveLength(30)
  expect(targets).toContain('restored')
  expect(targets).toContain('owned-29')
  expect(targets).not.toContain('finished')
  expect(targets).not.toContain('owned-0')
  expect(f.events.eventNames().some(n => String(n).startsWith('subagents:rpc:v1:reply:'))).toBe(false)
})
