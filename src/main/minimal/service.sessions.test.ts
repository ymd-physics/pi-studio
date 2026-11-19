import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const native = vi.hoisted(() => ({ processes: [] as any[], next: 0 }))
vi.mock('./rpc', () => ({
  PiProcess: class {
    stop = vi.fn(async () => {})
    send = vi.fn(async () => {})
    request = vi.fn(async (type: string) => {
      if (type === 'get_state') return { sessionFile: this.path }
      if (type === 'prompt') return { disposition: 'started' }
      if (type === 'fork' || type === 'clone') this.path += '-fork'
      return { messages: [], commands: [], models: [], levels: [] }
    })
    constructor(
      _: unknown,
      public workspace: string,
      public path: string,
      public emit: (r: any) => void,
    ) {
      native.processes.push(this)
    }
  },
}))
import { DesktopService } from './service'
const dirs: string[] = []
afterEach(async () => {
  native.processes.length = 0
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
async function fixture(demand?: (needed: boolean) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pool-'))
  dirs.push(dir)
  const events: any[] = [],
    trash = vi.fn(async () => {})
  const service = new DesktopService(dir, (r) => events.push(r), trash, demand)
  service.preferences.workspaces = [{ path: dir, name: 'test' }]
  ;(service as any).sdk = {
    SessionManager: {
      list: async () => [],
      create: () => ({ getSessionFile: () => join(dir, `session-${++native.next}`) }),
    },
  }
  return { service, dir, events, trash }
}
describe('DesktopService session pool', () => {
  it('searches titles and archived message bodies without opening sessions', async () => {
    const { service, dir } = await fixture()
    const list = vi.fn(async () => [{ id:'a', path:join(dir,'a'), modified:0, firstMessage:'hello', name:'Thesis', allMessagesText:'hello later CODE example' }])
    ;(service as any).sdk.SessionManager.list = list
    expect(await service.sessions(dir, 'code')).toMatchObject([{ id:'a', matchSnippet:'hello later CODE example' }])
    expect(await service.sessions(dir, 'thesis')).toHaveLength(1)
    expect(await service.sessions(dir, 'missing')).toEqual([])
    await expect(service.sessions(join(dir,'other'), 'code')).rejects.toThrow()
    expect(list).toHaveBeenCalledTimes(3)
    expect(native.processes).toHaveLength(0)
  })
  it('tracks supported models across hidden sessions, snapshots, errors and shutdown', async () => {
    const demand = vi.fn()
    const { service, dir } = await fixture(demand)
    const a = await service.open(dir), b = await service.open(dir)
    const codex = { provider: 'openai-codex', api: 'openai-codex-responses' }
    const other = { provider: 'other', api: 'other' }
    const p = native.processes[0], q = native.processes[1]
    p.request.mockImplementationOnce(async () => codex)
    await service.command('set_model', {}, a.handle)
    expect(demand.mock.calls).toEqual([[true]])
    q.request.mockImplementationOnce(async () => codex)
    await service.command('set_model', {}, b.handle)
    await service.closeSession(b.handle)
    expect(demand.mock.calls).toEqual([[true]])
    p.request.mockImplementation(async (type: string) => type === 'get_state'
      ? { sessionFile: p.path, model: other }
      : { messages: [], commands: [], models: [], levels: [] })
    await service.snapshot(a.handle)
    expect(demand.mock.calls).toEqual([[true], [false]])
    p.request.mockImplementationOnce(async () => codex)
    await service.command('set_model', {}, a.handle)
    p.emit({ type: 'desktop_error' })
    expect(demand.mock.calls).toEqual([[true], [false], [true], [false]])
    await service.shutdown()
  })
  it('pauses on reload and re-evaluates the replacement snapshot', async () => {
    const demand = vi.fn()
    const { service, dir } = await fixture(demand)
    const a = await service.open(dir)
    native.processes[0].request.mockImplementationOnce(async () => ({ provider: 'openai-codex', api: 'openai-codex-responses' }))
    await service.command('set_model', {}, a.handle)
    await service.reload(a.handle)
    expect(demand.mock.calls).toEqual([[true], [false]])
    await service.shutdown()
  })
  it('clears demand immediately on shutdown and workspace removal', async () => {
    for (const action of ['shutdown', 'remove'] as const) {
      const demand = vi.fn()
      const { service, dir } = await fixture(demand)
      const a = await service.open(dir)
      native.processes.at(-1).request.mockImplementationOnce(async () => ({ provider: 'openai-codex', api: 'openai-codex-responses' }))
      await service.command('set_model', {}, a.handle)
      if (action === 'shutdown') await service.shutdown()
      else await service.removeWorkspace(dir, true)
      expect(demand.mock.calls).toEqual([[true], [false]])
      await service.shutdown()
    }
  })
  it('does not broadcast sidebar refreshes for read-only stats and task queries', async () => {
    const { service, dir, events } = await fixture()
    const session = await service.open(dir)
    for (const working of [false, true]) {
      if (working) await service.command('prompt', { message: 'work' }, session.handle)
      events.length = 0
      await service.command('get_session_stats', {}, session.handle)
      await service.command('get_entries', {}, session.handle)
      expect(events.filter((event) => event.type === 'desktop_sessions_changed')).toHaveLength(0)
    }
    await service.shutdown()
  })
  it('confirmed workspace removal awaits every writer and prevents new opens', async () => {
    const { service, dir } = await fixture()
    const a = await service.open(dir)
    await service.open(dir)
    await service.command('prompt', { message: 'work' }, a.handle)
    let finish!: () => void
    native.processes[0].stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    let removed = false
    const removing = service.removeWorkspace(dir, true).then(() => {
      removed = true
    })
    await vi.waitFor(() => expect(native.processes[0].stop).toHaveBeenCalled())
    expect(removed).toBe(false)
    await expect(service.open(dir)).rejects.toThrow()
    finish()
    await removing
    expect(native.processes.every((process) => process.stop.mock.calls.length === 1)).toBe(true)
    expect(service.runningSessions()).toEqual([])
    expect(service.preferences.workspaces).toEqual([])
    await service.shutdown()
  })
  it('does not submit an attachment after stop or queue recall overtakes its file preparation', async () => {
    const { service, dir } = await fixture()
    const a = await service.open(dir)
    let release!: (value: any) => void
    vi.spyOn(service.assets, 'prepare').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const retained = vi.spyOn(service.assets, 'retain')
    const send = service.command('steer', { message: 'pending image', attachmentIds: ['draft'] }, a.handle)
    await service.command('clear_queue', {}, a.handle)
    release({ attachments: [], images: [] })
    await expect(send).rejects.toThrow('cancelled before submission')
    expect(native.processes[0].request.mock.calls.some(([type]: string[]) => type === 'steer')).toBe(false)
    expect(retained).not.toHaveBeenCalled()
    expect(native.processes[0].stop).not.toHaveBeenCalled()
    await service.shutdown()
  })
  it('keeps native compaction refusals usable and queues messages without waiting for an extension handler', async () => {
    const { service, dir } = await fixture()
    const a = await service.open(dir)
    const process = native.processes[0]
    process.request.mockRejectedValueOnce(
      Object.assign(new Error('Compaction cancelled'), { code: 'PI_RESPONSE_REJECTED' }),
    )
    await expect(service.command('compact', {}, a.handle)).rejects.toThrow('cancelled')
    expect(process.stop).not.toHaveBeenCalled()
    let release!: (value: unknown) => void
    process.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = service.command('prompt', { message: '/slow-command' }, a.handle)
    await Promise.resolve()
    await service.command('steer', { message: 'adjust course' }, a.handle)
    await service.command('follow_up', { message: 'next question' }, a.handle)
    process.emit({ type: 'queue_update', steering: ['adjust course'], followUp: ['next question'] })
    release({ disposition: 'handled' })
    await pending
    expect((await service.snapshot(a.handle)).queued).toEqual({
      steering: ['adjust course'],
      followUp: ['next question'],
    })
    await service.shutdown()
  })
  it('keeps independent processes, handles and event ownership across selection', async () => {
    const { service, dir, events } = await fixture()
    const a = await service.open(dir),
      b = await service.open(dir)
    await service.command('prompt', { message: 'A' }, a.handle)
    native.processes[0].emit({ type: 'agent_end' })
    expect(service.runningSessions().map((s) => s.status)).toEqual(['working', 'active'])
    expect((await service.snapshot(b.handle)).handle).toBe(b.handle)
    expect((await service.open(dir, a.state.sessionFile)).handle).toBe(a.handle)
    expect(native.processes).toHaveLength(2)
    expect(native.processes[0].stop).not.toHaveBeenCalled()
    native.processes[0].emit({ type: 'agent_settled' })
    expect(events.find((e) => e.type === 'agent_settled').desktopSession).toBe(a.handle)
    expect(service.runningSessions()[0].status).toBe('active')
    await service.shutdown()
    expect(native.processes.every((p) => p.stop.mock.calls.length === 1)).toBe(true)
  })
  it('protects accepted prompts before agent_start from close, reload, fork, delete and workspace removal', async () => {
    const { service, dir, trash } = await fixture()
    const a = await service.open(dir)
    await service.command('prompt', { message: 'A' }, a.handle)
    await expect(async () => service.closeSession(a.handle)).rejects.toThrow('Stop')
    await expect(async () => service.reload(a.handle)).rejects.toThrow('Stop')
    await expect(service.command('fork', {}, a.handle)).rejects.toThrow('Stop')
    await expect(async () => service.deleteSession(dir, a.state.sessionFile!)).rejects.toThrow('Stop')
    await expect(service.removeWorkspace(dir)).rejects.toThrow('Stop')
    expect(trash).not.toHaveBeenCalled()
    expect(native.processes[0].stop).not.toHaveBeenCalled()
    await service.shutdown()
  })
  it('deduplicates concurrent opens and tracks fork path without changing handle', async () => {
    const { service, dir } = await fixture()
    const a = await service.open(dir)
    const [one, two] = await Promise.all([
      service.open(dir, a.state.sessionFile),
      service.open(dir, a.state.sessionFile),
    ])
    expect(one.handle).toBe(two.handle)
    await service.command('fork', {}, a.handle)
    const fork = await service.snapshot(a.handle)
    expect(fork.state.sessionFile).toBe(a.state.sessionFile + '-fork')
    expect((await service.open(dir, fork.state.sessionFile)).handle).toBe(a.handle)
    expect(native.processes).toHaveLength(1)
    expect((await service.sessions(dir)).find((s) => s.handle === a.handle)?.path).toBe(
      fork.state.sessionFile,
    )
    expect((await service.sessions(dir)).find((s) => s.path === a.state.sessionFile)?.status).toBe('inactive')
    await service.shutdown()
  })
  it.each(['fork', 'prompt'])(
    'protects unpublished paths during %s until ownership reconciliation',
    async (type) => {
      const { service, dir, trash } = await fixture()
      const a = await service.open(dir)
      const forkPath = a.state.sessionFile + '-new'
      ;(service as any).sdk.SessionManager.list = async () => [
        { id: 'fork', path: forkPath, modified: Date.now(), firstMessage: '', messageCount: 1 },
      ]
      let release!: (result: any) => void
      native.processes[0].request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      const transition = service.command(
        type,
        type === 'prompt' ? { message: '/extension-fork' } : {},
        a.handle,
      )
      await Promise.resolve()
      await expect(service.open(dir, forkPath)).rejects.toThrow('changing')
      await expect(async () => service.deleteSession(dir, forkPath)).rejects.toThrow('changing')
      native.processes[0].path = forkPath
      release({ disposition: 'handled' })
      await transition
      expect((await service.open(dir, forkPath)).handle).toBe(a.handle)
      expect(native.processes).toHaveLength(1)
      expect(trash).not.toHaveBeenCalled()
      await service.shutdown()
    },
  )
  it('keeps pending extension prompts/dialogs busy and caches UI for startup hydration', async () => {
    const { service, dir } = await fixture()
    const a = await service.open(dir),
      process = native.processes[0]
    process.emit({
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: 'test',
      statusText: 'ready',
    })
    process.emit({
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: 'other',
      statusText: 'also ready',
    })
    process.emit({ type: 'extension_ui_request', method: 'confirm', id: 'dialog', timeout: 1000 })
    const hydrated = await service.snapshot(a.handle)
    expect(hydrated.ui).toHaveLength(3)
    expect(hydrated.state.isStreaming).toBe(true)
    await expect(async () => service.closeSession(a.handle)).rejects.toThrow('Stop')
    await service.respond({
      type: 'extension_ui_response',
      desktopSession: a.handle,
      id: 'dialog',
      confirmed: true,
    })
    process.request.mockImplementation(async (type: string) =>
      type === 'prompt' ? { disposition: 'handled' } : {},
    )
    await service.command('prompt', { message: '/extension' }, a.handle)
    expect(service.runningSessions()[0].status).toBe('active')
    await service.closeSession(a.handle)
  })
  it('does not serialize unrelated sessions behind a pending prompt', async () => {
    const { service, dir } = await fixture()
    const a = await service.open(dir),
      b = await service.open(dir)
    let finish!: (value: any) => void
    native.processes[0].request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = service.command('prompt', { message: '/slow' }, a.handle)
    await Promise.resolve()
    await service.command('get_state', {}, b.handle)
    expect(service.runningSessions()[0].status).toBe('working')
    finish({ disposition: 'handled' })
    await pending
    await service.shutdown()
  })
  it('rejects queued reload during shutdown without spawning a replacement', async () => {
    const { service, dir } = await fixture()
    const a = await service.open(dir)
    let release!: () => void
    const live = (service as any).pool.get(a.handle)
    live.queue = new Promise<void>((resolve) => {
      release = resolve
    })
    const reload = service.reload(a.handle)
    const stopped = service.shutdown()
    release()
    await expect(reload).rejects.toThrow('shutting down')
    await stopped
    expect(native.processes).toHaveLength(1)
    expect(native.processes[0].stop).toHaveBeenCalledTimes(1)
  })
  it('reserves file ownership until the old writer has actually stopped', async () => {
    const { service, dir } = await fixture()
    const a = await service.open(dir)
    let release!: () => void
    native.processes[0].stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const closing = service.closeSession(a.handle)
    await Promise.resolve()
    await expect(service.open(dir, a.state.sessionFile)).rejects.toThrow('changing')
    release()
    await closing
    expect(native.processes).toHaveLength(1)
  })
  it('shutdown waits for a stop already in progress', async () => {
    const { service, dir } = await fixture()
    const a = await service.open(dir)
    let release!: () => void
    native.processes[0].stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const closing = service.closeSession(a.handle)
    await Promise.resolve()
    let stopped = false
    const shutdown = service.shutdown().then(() => {
      stopped = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(stopped).toBe(false)
    release()
    await Promise.all([closing, shutdown])
    expect(native.processes[0].stop).toHaveBeenCalledTimes(1)
  })
  it('lists lazily persisted empty sessions after close and deletes them without Trash', async () => {
    const { service, dir, trash } = await fixture()
    const a = await service.open(dir)
    await service.closeSession(a.handle)
    expect((await service.sessions(dir))[0]).toMatchObject({ path: a.state.sessionFile, status: 'inactive' })
    const reopened = await service.open(dir, a.state.sessionFile)
    expect(reopened.handle).not.toBe(a.handle)
    await service.deleteSession(dir, a.state.sessionFile!)
    expect(await service.sessions(dir)).toEqual([])
    expect(trash).not.toHaveBeenCalled()
    expect(service.runningSessions()).toEqual([])
  })
  it('does not revive working after settlement arriving before prompt acknowledgement', async () => {
    const { service, dir } = await fixture()
    const a = await service.open(dir),
      process = native.processes[0]
    process.request.mockImplementation(async () => {
      process.emit({ type: 'agent_settled' })
      return { disposition: 'started' }
    })
    await service.command('prompt', { message: 'fast' }, a.handle)
    expect(service.runningSessions()[0].status).toBe('active')
    await service.shutdown()
  })
})
