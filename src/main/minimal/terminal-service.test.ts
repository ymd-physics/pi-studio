import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { TerminalService } from './terminal-service'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function fixture(handshakeTimeout = 4000) {
  const home = await mkdtemp(join(tmpdir(), 'terminal-service-'))
  const records: any[] = [], writes: string[] = [], requests: any[] = []
  let event!: (value: any) => void, exited!: (value: any) => void, data!: (value: string) => void, fail!: () => void
  const process = { pid: 1234, write: (s: string) => writes.push(s), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), close: vi.fn(async () => {}) }
  const channel = { path: '/tmp/test', token: 'a'.repeat(48), dispatch: '\x1b[6973;123456789~', setDispatcher: vi.fn(), connected: true, expectPid: vi.fn(), close: vi.fn(async () => {}), request: vi.fn((action: string, text: string, cursor: number, generation: number) => {
    const d = deferred<any>(); const request = { action, text, cursor, generation, id: requests.length + 1, ...d }; requests.push(request); return request
  }) }
  const service = new TerminalService(record => records.push(record), () => [{ path: home, name: 'workspace' }], { HOME: home }, 'test', '/fake', {
    channel: async (handler: any, failed: () => void) => { event = handler; fail = failed; return channel },
    prepare: async () => ({ file: '/bin/zsh', args: ['-f'], env: {}, integrated: true, cleanup: async () => {} }),
    process: options => { exited = options.onExit; data = options.onData; return process }, handshakeTimeout,
  })
  const create = async () => { const info = await service.create(home); event({ type: 'init', context: 'start', mode: 'fixed', generation: 1, cwd: home }); return info.id }
  return { home, records, writes, requests, process, channel, service, create, event: (value: any) => event(value), exited: (value: any) => exited(value), data: (value: string) => data(value), fail: () => fail(), cleanup: async () => { await service.shutdown(); await rm(home, { recursive: true, force: true }) } }
}

it('authorizes canonical workspaces, bounds sessions and names, routes output and cleans up', async () => {
  const f = await fixture()
  try {
    await expect(f.service.create('/')).rejects.toThrow()
    await expect(f.service.create(f.home, 0, 1)).rejects.toThrow()
    const id = await f.create()
    expect(() => f.service.rename(id, 'x'.repeat(81))).toThrow()
    f.service.rename(id, 'work'); expect(f.service.list()[0].name).toBe('work')
    f.data('hello'); await new Promise(r => setTimeout(r, 10))
    expect(f.records.some(r => r.type === 'desktop_terminal_output')).toBe(false)
    f.service.attach(id); await new Promise(r => setTimeout(r, 10))
    const packet = f.records.find(r => r.type === 'desktop_terminal_output')
    expect(packet.data).toBe('hello'); f.service.acknowledge(id, packet.sequence)
    expect(() => f.service.write(id, 'oops\r')).toThrow()
    f.service.write(id, '\x1b[1;2R'); expect(f.writes).toEqual(['\x1b[1;2R'])
    for (let i = 1; i < 8; i++) await f.create()
    await expect(f.service.create(f.home)).rejects.toThrow('limit')
    await f.service.removeWorkspace(f.home); expect(f.service.list()).toEqual([])
    await f.service.close(id)
  } finally { await f.cleanup() }
})

it('retries failed process cleanup during shutdown', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    f.process.close.mockRejectedValueOnce(new Error('inspection failed'))
    await expect(f.service.close(id)).rejects.toThrow('cleanup failed')
    expect(f.service.list()).toEqual([])
    await f.service.shutdown()
    expect(f.process.close).toHaveBeenCalledTimes(2)
  } finally { await f.cleanup() }
})

it('retains failed cleanup after natural exit for workspace removal', async () => {
  const f = await fixture()
  try {
    await f.create()
    f.process.close.mockRejectedValueOnce(new Error('inspection failed'))
    f.exited({ exitCode: 0 })
    await vi.waitFor(() => expect(f.records.some(r => r.type === 'desktop_terminal_error' && r.message === 'Terminal cleanup failed')).toBe(true))
    await f.service.removeWorkspace(f.home)
    expect(f.process.close).toHaveBeenCalledTimes(2)
  } finally { await f.cleanup() }
})

it('holds workspace removal across in-flight creation and unregister', async () => {
  const home = await mkdtemp(join(tmpdir(), 'terminal-removal-'))
  const entered = deferred<void>(), release = deferred<void>(), unregisterEntered = deferred<void>(), unregisterRelease = deferred<void>()
  const spawn = vi.fn(() => ({ pid: 123, write() {}, resize() {}, pause() {}, resume() {}, close: async () => {} }))
  const service = new TerminalService(() => {}, () => [{ path: home, name: 'home' }], { HOME: home }, '', '', {
    channel: async () => { entered.resolve(); await release.promise; throw new Error('fallback') },
    process: spawn,
  })
  try {
    const creating = service.create(home)
    const rejected = expect(creating).rejects.toThrow('Workspace is closing')
    await entered.promise
    const removal = service.removeWorkspace(home, async () => { unregisterEntered.resolve(); await unregisterRelease.promise })
    release.resolve()
    await rejected
    await unregisterEntered.promise
    await expect(service.create(home)).rejects.toThrow('Workspace is closing')
    expect(spawn).not.toHaveBeenCalled()
    unregisterRelease.resolve(); await removal
    await service.create(home)
    expect(spawn).toHaveBeenCalledOnce()
  } finally { release.resolve(); unregisterRelease.resolve(); await service.shutdown(); await rm(home, { recursive: true, force: true }) }
})

it('only sends the private dispatch key at the same live ready shell generation', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const dispatch = f.channel.setDispatcher.mock.calls[0][0] as (generation: number) => void
    dispatch(1)
    expect(f.writes).toEqual([f.channel.dispatch])
    expect(() => dispatch(2)).toThrow('stale')
    f.event({ type: 'finish', context: 'start', generation: 1 })
    expect(() => dispatch(1)).toThrow('stale')
    await f.service.close(id)
    expect(() => dispatch(1)).toThrow('stale')
    expect(f.writes).toHaveLength(1)
  } finally { await f.cleanup() }
})
it('cleans a partially constructed session after shell preparation failure', async () => {
  const home = await mkdtemp(join(tmpdir(), 'terminal-failure-'))
  const close = vi.fn(async () => {})
  const service = new TerminalService(() => {}, () => [{ path: home, name: 'home' }], { HOME: home, SHELL: '/definitely/not-a-shell' }, '', '', {
    channel: async () => ({ path: '/tmp/test', token: 'a', dispatch: '', setDispatcher() {}, connected: false, expectPid() {}, request() { throw new Error('unused') }, close }),
    prepare: async () => { throw new Error('preparation failed') },
  })
  try {
    await expect(service.create(home)).rejects.toThrow('shell unavailable')
    expect(close).toHaveBeenCalledOnce(); expect(service.list()).toEqual([])
  } finally { await service.shutdown(); await rm(home, { recursive: true, force: true }) }
})

it('falls back to direct mode on missing handshake and ignores late readiness', async () => {
  const f = await fixture(10)
  try {
    const id = (await f.service.create(f.home)).id
    expect(f.service.list()[0].state).toBe('starting')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(f.service.list()[0]).toMatchObject({ state: 'ready', mode: 'direct', reason: 'Shell integration unavailable' })
    f.event({ type: 'init', context: 'start', mode: 'fixed', generation: 1, cwd: f.home })
    await expect(f.service.submit(id, 'unsafe')).rejects.toThrow()
    expect(f.writes).toEqual([])
  } finally { await f.cleanup() }
})

it('falls back visibly to direct mode when integration setup fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'terminal-fallback-'))
  const spawn = vi.fn((_options: any) => ({ pid: 12, write() {}, resize() {}, pause() {}, resume() {}, close: async () => {} }))
  const service = new TerminalService(() => {}, () => [{ path: home, name: 'home' }], { HOME: home, SHELL: '/bin/zsh' }, '', '', {
    channel: async () => { throw new Error('socket unavailable') }, process: spawn,
  })
  try {
    const info = await service.create(home)
    expect(info).toMatchObject({ state: 'ready', mode: 'direct', reason: 'Shell integration unavailable' })
    expect(spawn.mock.calls[0][0]).toMatchObject({ file: '/bin/zsh', args: ['-l', '-i'], env: { HOME: home } })
    await expect(service.submit(info.id, 'echo no')).rejects.toThrow()
  } finally { await service.shutdown(); await rm(home, { recursive: true, force: true }) }
})

it('tears down on private-channel failure without publishing user input', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const submission = f.service.submit(id, 'secret-command')
    const rejected = expect(submission).rejects.toThrow()
    f.fail(); f.requests[0].reject(new Error('closed'))
    await rejected
    expect(f.service.list()).toEqual([])
    expect(f.process.close).toHaveBeenCalledOnce()
    expect(JSON.stringify(f.records)).not.toContain('secret-command')
    await f.service.close(id)
  } finally { await f.cleanup() }
})

it('submits only after load ACK, rejects concurrent operations and never commits a stale load', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const submit = f.service.submit(id, 'echo safe')
    expect(f.requests[0]).toMatchObject({ action: 's', text: 'echo safe', generation: 1 })
    expect(f.writes).toEqual([])
    expect(() => f.service.write(id, 'other\r')).toThrow()
    await expect(f.service.submit(id, 'other')).rejects.toThrow()
    f.requests[0].resolve({ generation: 1 }); await submit
    expect(f.writes).toEqual(['\r'])
    expect(f.service.list()[0]).toMatchObject({ state: 'running', mode: 'direct' })
    f.service.write(id, 'foreground input\r')
    f.event({ type: 'init', context: 'start', mode: 'fixed', generation: 2, cwd: f.home })
    const stale = f.service.submit(id, 'must-not-run')
    f.requests[1].resolve({ generation: 2 })
    await f.service.close(id)
    await expect(stale).rejects.toThrow()
    expect(f.writes).toEqual(['\r', 'foreground input\r'])
  } finally { await f.cleanup() }
})

it('confirms cancellation after load timeout and closes when cancellation cannot be confirmed', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const first = f.service.submit(id, 'one'); const failure = expect(first).rejects.toThrow()
    f.requests[0].reject(new Error('timeout')); await Promise.resolve()
    expect(f.requests[1]).toMatchObject({ action: 'x', text: '1', generation: 1 })
    f.requests[1].resolve({ generation: 1 }); await failure
    expect(f.service.list()).toHaveLength(1); expect(f.writes).toEqual([])
    const second = f.service.submit(id, 'two'); const failure2 = expect(second).rejects.toThrow()
    f.requests[2].reject(new Error('timeout')); await Promise.resolve()
    f.requests[3].reject(new Error('timeout')); await failure2
    expect(f.service.list()).toEqual([]); expect(f.writes).toEqual([])
  } finally { await f.cleanup() }
})

it('routes completion and explicit direct handoff without snapshotting a running program', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const completion = f.service.complete(id, 'ec', 2)
    f.requests[0].resolve({ generation: 1, buffer: 'echo', cursor: 4, options: [{ buffer: 'echo ', cursor: 5 }] })
    await expect(completion).resolves.toEqual({ buffer: 'echo', cursor: 4, options: [{ buffer: 'echo ', cursor: 5 }] })
    const handoff = f.service.setMode(id, 'direct', 'echo', 4)
    expect(f.requests[1]).toMatchObject({ action: 'd', text: 'echo', cursor: 4 })
    f.requests[1].resolve({ generation: 1 }); await handoff
    const restore = f.service.setMode(id, 'command')
    expect(f.requests[2]).toMatchObject({ action: 'g', text: '' })
    f.requests[2].resolve({ generation: 1, buffer: 'echo', cursor: 4 })
    await expect(restore).resolves.toEqual({ buffer: 'echo', cursor: 4 })
    await f.service.interrupt(id)
    expect(f.writes).toEqual([])
    expect(f.requests).toHaveLength(3)
    expect(f.service.list()[0]).toMatchObject({ state: 'ready', mode: 'command' })
    f.event({ type: 'finish', context: 'start', generation: 1 })
    await f.service.interrupt(id)
    expect(f.writes).toEqual(['\x03'])
    f.event({ type: 'init', context: 'cont', mode: 'direct', generation: 2, cwd: f.home })
    await f.service.interrupt(id)
    expect(f.writes).toEqual(['\x03', '\x03'])
    expect(f.requests).toHaveLength(3)
  } finally { await f.cleanup() }
})

it('cancels an in-flight load without Enter, Ctrl-C or delayed execution', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const submission = f.service.submit(id, 'must-not-run')
    const rejected = expect(submission).rejects.toThrow('cancelled')
    const interruption = f.service.interrupt(id)
    f.requests[0].resolve({ generation: 1 })
    await Promise.resolve()
    expect(f.requests[1]).toMatchObject({ action: 'x', text: '1', generation: 1 })
    expect(f.writes).toEqual([])
    f.requests[1].resolve({ generation: 1 })
    await rejected
    await interruption
    expect(f.service.list()[0]).toMatchObject({ state: 'ready', mode: 'command' })
    expect(f.writes).toEqual([])
    const next = f.service.submit(id, 'echo fresh')
    f.requests[2].resolve({ generation: 1 })
    await next
    expect(f.writes).toEqual(['\r'])
    expect(f.requests.some((request) => request.action === 'k')).toBe(false)
  } finally { await f.cleanup() }
})

it('retains output across natural exit and late attach until cumulative acknowledgement', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    f.data('last output'); f.exited({ exitCode: 0 })
    expect(f.service.list()).toEqual([])
    f.service.attach(id)
    await new Promise(resolve => setTimeout(resolve, 10))
    const packet = f.records.find(r => r.type === 'desktop_terminal_output')
    expect(packet.data).toBe('last output')
    f.service.acknowledge(id, packet.sequence)
    expect(() => f.service.attach(id)).toThrow()
  } finally { await f.cleanup() }
})

it('rejects stale completions and never snapshots continuation or running input', async () => {
  const f = await fixture()
  try {
    const id = await f.create()
    const completion = f.service.complete(id, '😀x', 2)
    f.event({ type: 'finish', context: 'start', generation: 1 })
    f.requests[0].resolve({ generation: 1, buffer: 'done', cursor: 4, options: [] })
    await expect(completion).rejects.toThrow('stale')
    await expect(f.service.setMode(id, 'command')).rejects.toThrow()
    f.event({ type: 'init', context: 'cont', mode: 'direct', generation: 2, cwd: f.home })
    await expect(f.service.setMode(id, 'command')).rejects.toThrow()
    expect(f.requests).toHaveLength(1)
  } finally { await f.cleanup() }
})
