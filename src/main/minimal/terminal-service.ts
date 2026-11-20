import { assetPath } from './workspace-assets'
import { randomUUID } from 'node:crypto'
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { userInfo } from 'node:os'
import type { PiRecord } from '../../../packages/shared/desktop'
import type { TerminalCompletion, TerminalInfo } from '../../../packages/shared/terminal'
import { TerminalChannel, type TerminalChannelEvent } from './terminal-channel'
import { TerminalOutputPump } from './terminal-output'
import { TerminalProcess } from './terminal-process'
import { prepareTerminalShell, terminalEnvironment, type PreparedTerminalShell } from './terminal-shell'

type ProcessLike = Pick<TerminalProcess, 'pid' | 'write' | 'resize' | 'pause' | 'resume' | 'close'>
type ChannelLike = Pick<TerminalChannel, 'path' | 'token' | 'dispatch' | 'setDispatcher' | 'connected' | 'expectPid' | 'request' | 'close'>
type Session = {
  info: TerminalInfo; process: ProcessLike; channel?: ChannelLike; shell: PreparedTerminalShell; pump: TerminalOutputPump
  generation: number; context: string; operation: boolean; closing: boolean; startup?: ReturnType<typeof setTimeout>
  submission?: { cancelled: boolean; done: Promise<void> }
}
type ProcessOptions = ConstructorParameters<typeof TerminalProcess>[0]
type Dependencies = {
  prepare?: typeof prepareTerminalShell
  channel?: (event: (event: TerminalChannelEvent) => void, failed: () => void) => Promise<ChannelLike>
  process?: (options: ProcessOptions) => ProcessLike
  handshakeTimeout?: number
  requestTimeout?: number
}

/** Owns terminal sessions separately from Pi processes; callers own renderer draft state. */
export class TerminalService {
  private sessions = new Map<string, Session>()
  private retired = new Map<string, { pump: TerminalOutputPump; timer: ReturnType<typeof setTimeout> }>()
  private closing = new Map<string, Promise<void>>()
  private pendingCleanup = new Map<string, { workspace: string; cleanup: () => Promise<void> }>()
  private workspaceClosures = new Set<Promise<string>>()
  private creating = 0
  private creates = new Set<Promise<TerminalInfo>>()
  private stopped = false
  private options: Dependencies
  constructor(
    private emit: (record: PiRecord) => void,
    private workspaces: () => { path: string; name: string }[],
    private environment: NodeJS.ProcessEnv = process.env,
    private version = '',
    private integrationPath = '',
    options: Dependencies = {},
  ) { this.options = options }

  list(): TerminalInfo[] { return [...this.sessions.values()].map(session => ({ ...session.info })) }
  private publish() { this.emit({ type: 'desktop_terminal_sessions', terminals: this.list() }) }
  private nextName(workspace: string) {
    const names = new Set(this.list().filter((info) => info.workspace === workspace).map((info) => info.name))
    let name = 'Terminal', index = 1
    while (names.has(name)) name = `Terminal ${++index}`
    return name
  }
  private get(id: string): Session {
    const session = this.sessions.get(id)
    if (!session || session.closing) throw new Error('Terminal unavailable')
    return session
  }
  private async workspace(path: string): Promise<string> {
    if (typeof path !== 'string') throw new Error('Invalid workspace')
    const canonical = await realpath(path)
    if (!(await stat(canonical)).isDirectory()) throw new Error('Invalid workspace')
    const registered = await Promise.all(this.workspaces().map(item => realpath(item.path).catch(() => '')))
    if (!registered.includes(canonical)) throw new Error('Workspace is not registered')
    return canonical
  }

  create(workspace: string, cols = 100, rows = 30, directory = ''): Promise<TerminalInfo> {
    const promise = this.createSession(workspace, cols, rows, directory)
    this.creates.add(promise)
    void promise.finally(() => this.creates.delete(promise)).catch(() => {})
    return promise
  }
  private async createSession(workspace: string, cols: number, rows: number, directory: string): Promise<TerminalInfo> {
    if (this.stopped || this.sessions.size + this.creating >= 8) throw new Error('Terminal limit reached')
    if (!Number.isInteger(cols) || cols < 1 || cols > 1000 || !Number.isInteger(rows) || rows < 1 || rows > 1000) throw new Error('Invalid terminal dimensions')
    this.creating++
    const id = randomUUID()
    let shell: PreparedTerminalShell | undefined
    let channel: ChannelLike | undefined
    let process: ProcessLike | undefined
    let session: Session | undefined
    try {
      const cwd = await this.workspace(workspace)
      if ((await Promise.all(this.workspaceClosures)).includes(cwd)) throw new Error('Workspace is closing')
      if (this.stopped) throw new Error('Terminal service stopped')
      try {
        channel = await (this.options.channel || TerminalChannel.create)((event) => { if (session) this.event(session, event) }, () => {
          if (!session || session.closing) return
          if (session.info.state === 'starting') this.integrationUnavailable(session)
          else void this.close(session.info.id).catch(() => {})
        })
        shell = await (this.options.prepare || prepareTerminalShell)({ environment: this.environment, id, version: this.version, integrationPath: this.integrationPath, integrationEnvironment: { PI_DESKTOP_TERMINAL_SOCKET: channel.path, PI_DESKTOP_TERMINAL_TOKEN: channel.token, PI_DESKTOP_TERMINAL_DISPATCH: channel.dispatch } })
      } catch {
        await channel?.close().catch(() => {})
        channel = undefined
        const file = this.environment.SHELL || userInfo().shell || '/bin/zsh'
        if (!file.startsWith('/')) throw new Error('Terminal shell unavailable')
        try { await access(file, constants.X_OK) } catch { throw new Error('Terminal shell unavailable') }
        const env = terminalEnvironment(this.environment, { id, version: this.version })
        env.SHELL = file
        shell = { file, args: ['-l', '-i'], env, integrated: false, cleanup: async () => {} }
      }
      const startDir = directory ? await assetPath(cwd, directory) : cwd
      if (directory && !(await stat(startDir)).isDirectory()) throw new Error('Not a directory')
      await this.workspace(cwd)
      if ((await Promise.all(this.workspaceClosures)).includes(cwd)) throw new Error('Workspace is closing')
      if (this.stopped) throw new Error('Terminal service stopped')
      let earlyExit: { exitCode: number; signal?: number } | undefined
      let earlyData = ''
      process = (this.options.process || (options => new TerminalProcess(options)))({
        file: shell.file, args: shell.args, cwd: startDir, env: shell.env, cols, rows,
        onData: data => { if (session) session.pump.push(data); else earlyData += data },
        onExit: event => { if (session) this.exited(session, event); else earlyExit = event },
      })
      const info: TerminalInfo = { id, name: this.nextName(cwd), workspace: cwd, cwd: startDir, shell: shell.file, state: shell.integrated ? 'starting' : 'ready', mode: 'direct', ...(!shell.integrated ? { reason: 'Shell integration unavailable' } : {}) }
      const pump = new TerminalOutputPump(process, packet => this.emit({ type: 'desktop_terminal_output', id, ...packet }), () => {
        this.emit({ type: 'desktop_terminal_error', id, message: 'Terminal output failed' })
        void this.close(id).catch(() => {})
      }, () => this.releaseRetired(id))
      session = { info, process, channel, shell, pump, generation: 0, context: '', operation: false, closing: false }
      this.sessions.set(id, session)
      if (channel) {
        const current = session, dispatch = channel.dispatch
        channel.setDispatcher((generation) => {
          if (current.closing || this.sessions.get(id) !== current || current.generation !== generation || current.info.state !== 'ready' || current.context !== 'start') throw new Error('Terminal dispatch became stale')
          current.process.write(dispatch)
        })
        channel.expectPid(process.pid)
      }
      if (earlyData) pump.push(earlyData)
      if (shell.integrated) {
        const current = session
        session.startup = setTimeout(() => {
          if (!current.closing && current.info.state === 'starting') this.integrationUnavailable(current)
        }, this.options.handshakeTimeout ?? 4000)
      } else { void channel?.close().catch(() => {}); session.channel = undefined }
      this.publish()
      if (earlyExit) this.exited(session, earlyExit)
      return { ...info }
    } catch (error) {
      if (session) this.sessions.delete(id)
      const cleanup = async () => {
        const results = await Promise.allSettled([process?.close(), channel?.close(), shell?.cleanup()])
        if (results.some(result => result.status === 'rejected')) throw new Error('Terminal cleanup failed')
      }
      this.pendingCleanup.set(id, { workspace: session?.info.workspace || workspace, cleanup })
      await this.retryCleanup(id).catch(() => {})
      throw error
    } finally { this.creating-- }
  }

  private integrationUnavailable(session: Session) {
    if (session.startup) clearTimeout(session.startup)
    session.startup = undefined
    session.info.state = 'ready'; session.info.mode = 'direct'; session.info.reason = 'Shell integration unavailable'
    void session.channel?.close().catch(() => {})
    session.channel = undefined
    this.publish()
  }

  private event(session: Session, event: TerminalChannelEvent) {
    if (session.closing || !session.channel || !this.sessions.has(session.info.id)) return
    if (event.type === 'init') {
      if (event.generation <= session.generation) { void this.close(session.info.id).catch(() => {}); return }
      if (session.startup) clearTimeout(session.startup)
      session.startup = undefined
      session.generation = event.generation; session.context = event.context
      session.info.cwd = event.cwd || session.info.cwd
      session.info.state = 'ready'
      session.info.mode = event.mode === 'fixed' && event.context === 'start' ? 'command' : 'direct'
      delete session.info.reason
    } else {
      if (event.generation !== session.generation) { void this.close(session.info.id).catch(() => {}); return }
      session.info.state = 'running'; session.info.mode = 'direct'
      if (event.type === 'finish') session.context = event.context
    }
    this.publish()
  }

  private releaseRetired(id: string) {
    const retired = this.retired.get(id)
    if (!retired) return
    this.retired.delete(id); clearTimeout(retired.timer); retired.pump.close()
  }
  private exited(session: Session, event: { exitCode: number; signal?: number }) {
    const id = session.info.id
    if (!this.sessions.has(id)) return
    session.closing = true; this.sessions.delete(id)
    if (session.startup) clearTimeout(session.startup)
    // Keep already produced output reachable across exit/attach races, but bound retention.
    if (this.retired.size >= 8) {
      const oldest = this.retired.keys().next().value!
      this.emit({ type: 'desktop_terminal_error', id: oldest, message: 'Terminal output was not acknowledged' })
      this.releaseRetired(oldest)
    }
    const timer = setTimeout(() => {
      this.emit({ type: 'desktop_terminal_error', id, message: 'Terminal output was not acknowledged' })
      this.releaseRetired(id)
    }, 30000)
    this.retired.set(id, { pump: session.pump, timer })
    session.pump.finish()
    this.emit({ type: 'desktop_terminal_closed', id, exitCode: event.exitCode, ...(event.signal === undefined ? {} : { signal: event.signal }) })
    this.publish()
    this.rememberCleanup(session)
    void this.retryCleanup(id).catch(() => this.emit({ type: 'desktop_terminal_error', id, message: 'Terminal cleanup failed' }))
  }
  rename(id: string, name: string) {
    const session = this.get(id)
    if (typeof name !== 'string' || !name.trim() || Array.from(name).length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid terminal name')
    session.info.name = name; this.publish()
  }
  private rememberCleanup(session: Session) {
    this.pendingCleanup.set(session.info.id, { workspace: session.info.workspace, cleanup: async () => {
      const results = await Promise.allSettled([session.channel?.close(), session.process.close(), session.shell.cleanup()])
      if (results.some(result => result.status === 'rejected')) throw new Error('Terminal cleanup failed')
    } })
  }
  private retryCleanup(id: string): Promise<void> {
    const existing = this.closing.get(id)
    if (existing) return existing
    const pending = this.pendingCleanup.get(id)
    if (!pending) return Promise.resolve()
    const promise = pending.cleanup().then(() => { this.pendingCleanup.delete(id) }).finally(() => this.closing.delete(id))
    this.closing.set(id, promise)
    return promise
  }
  close(id: string): Promise<void> {
    this.releaseRetired(id)
    const existing = this.closing.get(id)
    if (existing) return existing
    const session = this.sessions.get(id)
    if (!session || session.closing) return this.retryCleanup(id)
    session.closing = true; this.sessions.delete(id)
    if (session.startup) clearTimeout(session.startup)
    session.pump.close(); this.publish()
    this.rememberCleanup(session)
    return this.retryCleanup(id)
  }
  async removeWorkspace<T = void>(workspace: string, unregister?: () => T | Promise<T>): Promise<T | undefined> {
    const canonicalPromise = realpath(workspace).catch(() => workspace)
    this.workspaceClosures.add(canonicalPromise)
    const creates = [...this.creates]
    try {
      const canonical = await canonicalPromise
      await Promise.allSettled(creates)
      const ids = new Set([...this.sessions.values()].filter(s => s.info.workspace === canonical).map(s => s.info.id))
      for (const [id, pending] of this.pendingCleanup) if (pending.workspace === canonical) ids.add(id)
      const results = await Promise.allSettled([...ids].map(id => this.close(id)))
      if (results.some(r => r.status === 'rejected')) throw new Error('Terminal cleanup failed')
      return await unregister?.()
    } finally { this.workspaceClosures.delete(canonicalPromise) }
  }
  async shutdown() {
    this.stopped = true
    await Promise.allSettled([...this.creates])
    for (const id of this.retired.keys()) this.releaseRetired(id)
    const results = await Promise.allSettled([...new Set([...this.sessions.keys(), ...this.closing.keys(), ...this.pendingCleanup.keys()])].map(id => this.close(id)))
    if (results.some(r => r.status === 'rejected')) throw new Error('Terminal cleanup failed')
  }
  attach(id: string) { (this.sessions.get(id)?.pump || this.retired.get(id)?.pump || this.get(id).pump).attach() }
  acknowledge(id: string, sequence: number) { (this.sessions.get(id)?.pump || this.retired.get(id)?.pump || this.get(id).pump).ack(sequence) }
  resize(id: string, cols: number, rows: number) { this.get(id).process.resize(cols, rows) }
  write(id: string, data: string) {
    const session = this.get(id)
    if (typeof data !== 'string' || Buffer.byteLength(data) > 65536) throw new Error('Invalid terminal input')
    // Terminal query replies are allowed even while keyboard input is blocked.
    const queryReply = /^(?:\x1b\[[0-?]*[ -/]*[cnRyt]|\x1b\[\?[0-9;:]*u|\x1b\][0-9]+;[^\x00-\x1f\x7f]*(?:\x07|\x1b\\)|\x1bP[^\x00-\x1f\x7f]*\x1b\\)+$/.test(data)
    if ((session.operation || session.info.mode === 'command') && !queryReply) throw new Error('Terminal keyboard input unavailable')
    session.process.write(data)
  }
  private ready(session: Session) {
    if (session.info.state !== 'ready' || session.info.mode !== 'command' || session.context !== 'start' || !session.channel?.connected) throw new Error('Terminal is not command-ready')
  }
  private same(session: Session, generation: number) {
    return !session.closing && this.sessions.get(session.info.id) === session && session.generation === generation && session.info.state === 'ready' && session.info.mode === 'command' && session.context === 'start'
  }
  private begin(session: Session) { if (session.operation) throw new Error('Terminal operation in progress'); session.operation = true }
  private request(session: Session, action: 'c' | 's' | 'x' | 'd' | 'g' | 'k', text: string, cursor: number, generation: number) {
    if (!session.channel) throw new Error('Terminal integration unavailable')
    return session.channel.request(action, text, cursor, generation, this.options.requestTimeout)
  }
  async submit(id: string, buffer: string) {
    const session = this.get(id); this.ready(session); this.begin(session)
    const generation = session.generation
    let finish!: () => void
    const submission = { cancelled: false, done: new Promise<void>((resolve) => { finish = resolve }) }
    session.submission = submission
    try {
      const request = this.request(session, 's', buffer, buffer.length, generation)
      let response
      try { response = await request.promise } catch {
        if (this.same(session, generation)) {
          try {
            const cancel = await this.request(session, 'x', String(request.id), 0, generation).promise
            if (cancel.generation !== generation || !this.same(session, generation)) throw new Error('Cancellation not confirmed')
          } catch { await this.close(id).catch(() => {}) }
        } else await this.close(id).catch(() => {})
        throw new Error('Terminal submission failed')
      }
      if (response.generation !== generation || !this.same(session, generation)) {
        await this.close(id).catch(() => {})
        throw new Error('Terminal submission became stale')
      }
      if (submission.cancelled) {
        try {
          const cancelled = await this.request(session, 'x', String(request.id), 0, generation).promise
          if (cancelled.generation !== generation || !this.same(session, generation)) throw new Error('Cancellation became stale')
        } catch {
          await this.close(id).catch(() => {})
          throw new Error('Terminal submission cancellation failed')
        }
        throw new Error('Terminal submission cancelled')
      }
      session.info.state = 'running'; session.info.mode = 'direct'
      try { session.process.write('\r') } catch {
        await this.close(id).catch(() => {})
        throw new Error('Terminal submission failed')
      }
      this.publish()
    } finally {
      if (session.submission === submission) session.submission = undefined
      session.operation = false
      finish()
    }
  }
  async complete(id: string, buffer: string, cursor: number): Promise<TerminalCompletion> {
    const session = this.get(id); this.ready(session); this.begin(session)
    const generation = session.generation
    try {
      let result
      try { result = await this.request(session, 'c', buffer, cursor, generation).promise } catch {
        await this.close(id).catch(() => {})
        throw new Error('Terminal completion unavailable')
      }
      if (!this.same(session, generation) || result.generation !== generation || result.buffer === undefined || result.cursor === undefined) throw new Error('Terminal completion became stale')
      return { buffer: result.buffer, cursor: result.cursor, options: result.options || [] }
    } finally { session.operation = false }
  }
  async setMode(id: string, mode: TerminalInfo['mode'], buffer = '', cursor = buffer.length): Promise<{ buffer?: string; cursor?: number }> {
    const session = this.get(id)
    if (mode !== 'command' && mode !== 'direct') throw new Error('Invalid terminal mode')
    if (mode === session.info.mode) return {}
    if (session.info.state !== 'ready' || session.context !== 'start' || !session.channel?.connected) throw new Error('Terminal mode unavailable')
    this.begin(session)
    const generation = session.generation
    try {
      const result = await this.request(session, mode === 'direct' ? 'd' : 'g', mode === 'direct' ? buffer : '', mode === 'direct' ? cursor : 0, generation).promise
      if (session.closing || session.generation !== generation || session.info.state !== 'ready' || result.generation !== generation) throw new Error('Terminal mode became stale')
      session.info.mode = mode; this.publish()
      return mode === 'command' ? { buffer: result.buffer, cursor: result.cursor } : {}
    } catch {
      await this.close(id).catch(() => {})
      throw new Error('Terminal mode change failed')
    } finally { session.operation = false }
  }
  async interrupt(id: string) {
    const session = this.get(id)
    if (session.submission) {
      // Cancel an explicitly submitted but not yet accepted line. Never append
      // Ctrl-C/Enter after a socket ACK: an empty fixed editor needs no ZLE wake.
      session.submission.cancelled = true
      await session.submission.done
      return
    }
    if (session.info.mode === 'command') return // The renderer cancels its own draft.
    if (session.operation) throw new Error('Terminal operation in progress')
    // Native direct input: no preceding FD widget, including at continuation prompts.
    session.process.write('\x03')
  }
}
