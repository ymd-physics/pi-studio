import { readFile, writeFile, mkdir, rename, realpath, stat, open, unlink } from 'node:fs/promises'
import { join, basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import type { Preferences, PiRecord, Snapshot, SessionInfo } from '../../../packages/shared/desktop'
import { discoverPi, loadSessionManager, type PiInstallation } from './runtime'
import { PiProcess } from './rpc'
import { projectTodos } from '../../../packages/shared/todo-state'
import { supportsCodexFeatures } from '../../../packages/shared/codex-model'
import { readPluginInventory } from './plugin-inventory'
import { parseSubagentStatus, SUBAGENT_STATUS_WIDGET } from '../../../packages/shared/subagents'
import { WorkspaceAssets, assetPath } from './workspace-assets'
import type { AttachmentInput, FileOperation } from '../../../packages/shared/assets'
import { workspaceFsListDir, workspaceFsReadText, resolvePathUnderWorkspace } from '../workspace-fs'

const allowed = new Set([
  'prompt',
  'steer',
  'follow_up',
  'abort',
  'clear_queue',
  'get_state',
  'get_messages',
  'get_commands',
  'get_available_models',
  'get_available_thinking_levels',
  'set_model',
  'set_thinking_level',
  'compact',
  'get_fork_messages',
  'fork',
  'clone',
  'get_tree',
  'get_entries',
  'set_session_name',
  'get_last_assistant_text',
  'get_session_stats',
  'export_html',
])
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

type LiveSession = {
  handle: string
  snapshot: Snapshot
  rpc?: PiProcess
  stopping?: Promise<void>
  epoch: number
  queue: Promise<unknown>
  pendingDialogs: Map<string, PiRecord>
  ui: Map<string, PiRecord>
  running: boolean
  prompts: number
  compacting: boolean
  mutating: boolean
  settled: number
  submissionVersion: number
}

export class DesktopService {
  preferences: Preferences = { workspaces: [], theme: 'system', font: 'default', enterToSend: true, terminalFontSize: 'auto' }
  private installation!: PiInstallation
  private sdk: any
  private current?: Snapshot
  private pool = new Map<string, LiveSession>()
  private opening = new Map<string, Promise<Snapshot>>()
  private deleting = new Set<string>()
  private pathChanges = 0
  private knownSessions = new Map<string, { workspace: string; info: SessionInfo }>()
  readonly assets = new WorkspaceAssets()
  private epoch = 0
  private lifecycle: Promise<unknown> = Promise.resolve()
  private shuttingDown = false
  private codexDemand = false
  constructor(
    private dataDir: string,
    private event: (record: PiRecord) => void,
    private trashSession: (path: string) => Promise<void> = async () => {
      throw new Error('Trash is unavailable')
    },
    private readonly codexDemandChanged?: (needed: boolean) => void,
  ) {}

  private updateCodexDemand() {
    const needed = !this.shuttingDown && [...this.pool.values()].some(
      (session) => !!session.rpc && supportsCodexFeatures(session.snapshot.state.model),
    )
    if (needed === this.codexDemand) return
    this.codexDemand = needed
    this.codexDemandChanged?.(needed)
  }

  async boot() {
    try {
      this.preferences = {
        ...this.preferences,
        ...JSON.parse(await readFile(join(this.dataDir, 'preferences.json'), 'utf8')),
      }
    } catch {
      /* first launch */
    }
    if (!['default', 'serif'].includes(this.preferences.font!)) this.preferences.font = 'default'
    const terminalSize = this.preferences.terminalFontSize
    if (terminalSize !== 'auto' && (!Number.isInteger(terminalSize) || typeof terminalSize !== 'number' || terminalSize < 10 || terminalSize > 22)) this.preferences.terminalFontSize = 'auto'
    this.installation = await discoverPi()
    this.sdk = await loadSessionManager(this.installation)
    return {
      preferences: this.preferences,
      runtime: `Pi ${this.installation.version} · ${this.installation.cli}`,
    }
  }
  private async persist() {
    await mkdir(this.dataDir, { recursive: true })
    const file = join(this.dataDir, 'preferences.json')
    await writeFile(file + '.tmp', JSON.stringify(this.preferences, null, 2))
    await rename(file + '.tmp', file)
    return this.preferences
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const guarded = () => {
      this.assertRunning()
      return fn()
    }
    const next = this.lifecycle.then(guarded, guarded)
    this.lifecycle = next.catch(() => {})
    return next
  }
  private assertRunning() {
    if (this.shuttingDown) throw new Error('Pi Studio is shutting down')
  }
  async shutdown() {
    this.shuttingDown = true
    this.updateCodexDemand()
    await this.lifecycle
    await Promise.all([...this.opening.values()].map((p) => p.catch(() => {})))
    await Promise.all([...this.pool.values()].map((session) => this.stop(session)))
  }
  updatePreferences(patch: Partial<Preferences>) {
    return this.serial(async () => {
      if (Object.hasOwn(patch, 'terminalFontSize')) {
        const size = patch.terminalFontSize
        if (size !== 'auto' && (typeof size !== 'number' || !Number.isInteger(size) || size < 10 || size > 22)) throw new Error('Terminal font size must be automatic or an integer from 10 to 22')
        this.preferences.terminalFontSize = size
      }
      if (['system', 'light', 'dark'].includes(patch.theme!)) this.preferences.theme = patch.theme!
      if (['default', 'serif'].includes(patch.font!)) this.preferences.font = patch.font!
      if (typeof patch.enterToSend === 'boolean') this.preferences.enterToSend = patch.enterToSend
      return this.persist()
    })
  }
  addWorkspace(path: string) {
    return this.serial(async () => {
      const canonical = await realpath(path)
      if (!(await stat(canonical)).isDirectory()) throw new Error('Choose a directory')
      if (!this.preferences.workspaces.some((w) => w.path === canonical))
        this.preferences.workspaces.push({ path: canonical, name: basename(canonical) || canonical })
      return this.persist()
    })
  }
  renameWorkspace(path: string, name: string) {
    return this.serial(async () => {
      if (typeof name !== 'string' || !name.trim() || Array.from(name.trim()).length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Workspace name must be 1–80 characters without control characters')
      const workspace = this.preferences.workspaces.find((item) => item.path === path)
      if (!workspace) throw new Error('Workspace is not registered')
      const previous = workspace.name
      workspace.name = name.trim()
      try { return await this.persist() }
      catch (error) { workspace.name = previous; throw error }
    })
  }
  removeWorkspace(path: string, stopWorking = false) {
    return this.serial(async () => {
      const sessions = [...this.pool.values()].filter((s) => s.snapshot.workspace === path)
      if (!stopWorking) sessions.forEach((s) => this.assertIdle(s))
      this.preferences.workspaces = this.preferences.workspaces.filter((w) => w.path !== path)
      await Promise.all(sessions.map((s) => this.stop(s)))
      if (this.preferences.activeWorkspace === path) {
        delete this.preferences.activeWorkspace
        delete this.preferences.activeSession
      }
      return this.persist()
    })
  }
  private authorize(workspace: string) {
    if (!this.preferences.workspaces.some((w) => w.path === workspace))
      throw new Error('Workspace is not registered')
    if (!this.sdk) throw new Error('Pi is unavailable')
  }
  private sessionDirectory(workspace: string): string | undefined {
    const configured =
      process.env.PI_CODING_AGENT_SESSION_DIR || this.sdk.SettingsManager?.create(workspace).getSessionDir?.()
    if (!configured) return undefined
    const expanded =
      configured === '~'
        ? homedir()
        : configured.startsWith('~/')
          ? join(homedir(), configured.slice(2))
          : configured
    return resolve(workspace, expanded)
  }
  private selected(handle = this.current?.handle): LiveSession {
    this.assertRunning()
    const session = handle && this.pool.get(handle)
    if (!session) throw new Error('No active session')
    return session
  }
  private status(session: LiveSession): 'inactive' | 'active' | 'working' {
    if (!session.rpc) return 'inactive'
    return session.running || session.prompts > 0 || session.compacting || session.pendingDialogs.size > 0
      ? 'working'
      : 'active'
  }
  runningSessions() {
    return [...this.pool.values()].map((s) => ({
      handle: s.handle,
      workspace: s.snapshot.workspace,
      path: s.snapshot.state.sessionFile,
      status: this.status(s),
    }))
  }
  private changed(session: LiveSession) {
    this.event({
      type: 'desktop_sessions_changed',
      desktopSession: session.handle,
      desktopEpoch: session.epoch,
      sessions: this.runningSessions(),
    })
  }
  private assertIdle(session: LiveSession) {
    if (this.status(session) === 'working' || session.mutating)
      throw new Error('Stop the current operation before changing this session')
  }
  private enqueue<T>(session: LiveSession, fn: () => Promise<T>): Promise<T> {
    const next = session.queue.then(() => {
      this.assertRunning()
      if (this.pool.get(session.handle) !== session) throw new Error('Session closed')
      return fn()
    })
    session.queue = next.catch(() => {})
    return next
  }
  async sessions(workspace: string): Promise<SessionInfo[]> {
    this.authorize(workspace)
    const disk = await this.sdk.SessionManager.list(workspace, this.sessionDirectory(workspace))
    const result: SessionInfo[] = disk.map((s: any) => ({
      id: s.id,
      path: s.path,
      name: s.name,
      firstMessage: s.firstMessage,
      modified: new Date(s.modified).toISOString(),
      messageCount: s.messageCount,
      status: 'inactive',
    }))
    for (const { workspace: owner, info } of this.knownSessions.values()) {
      if (owner === workspace && !result.some((s) => s.path === info.path))
        result.push({ ...info, status: 'inactive' })
    }
    for (const live of this.pool.values()) {
      if (live.snapshot.workspace !== workspace) continue
      const path = live.snapshot.state.sessionFile!
      let entry = result.find((s) => s.path === path)
      if (!entry) {
        entry = {
          id: live.handle,
          path,
          firstMessage: '',
          modified: new Date().toISOString(),
          messageCount: 0,
        }
        result.push(entry)
      }
      Object.assign(entry, { handle: live.handle, status: this.status(live) })
    }
    return result
  }
  open(workspace: string, path?: string): Promise<Snapshot> {
    this.assertRunning()
    const key = path ? `${workspace}\0${path}` : randomUUID()
    const pending = this.opening.get(key)
    if (pending) return pending
    const opening = this.openSession(workspace, path).finally(() => this.opening.delete(key))
    this.opening.set(key, opening)
    return opening
  }
  private async openSession(workspace: string, path?: string): Promise<Snapshot> {
    this.authorize(workspace)
    if (path && !(await this.sessions(workspace)).some((s) => s.path === path))
      throw new Error('Session does not belong to this workspace')
    this.assertRunning()
    this.authorize(workspace)
    if (path && this.deleting.has(path)) throw new Error('Session is being deleted')
    let session = [...this.pool.values()].find((s) => path && s.snapshot.state.sessionFile === path)
    if (session?.mutating) throw new Error('Session is changing; try again')
    if (session && !session.rpc) {
      await this.stop(session)
      session = undefined
    }
    if (!session) {
      if (path && this.pathChanges) throw new Error('A session path is changing; try again')
      const sessionFile =
        path || this.sdk.SessionManager.create(workspace, this.sessionDirectory(workspace)).getSessionFile()
      const handle = randomUUID()
      session = {
        handle,
        snapshot: {
          handle,
          workspace,
          messages: [],
          state: { sessionFile },
          models: [],
          commands: [],
          levels: [],
        },
        epoch: 0,
        queue: Promise.resolve(),
        pendingDialogs: new Map(),
        ui: new Map(),
        running: false,
        prompts: 0,
        compacting: false,
        mutating: true,
        settled: 0,
        submissionVersion: 0,
      }
      this.pool.set(handle, session)
      this.knownSessions.set(sessionFile, {
        workspace,
        info: {
          id: handle,
          path: sessionFile,
          firstMessage: '',
          modified: new Date().toISOString(),
          messageCount: 0,
        },
      })
      try {
        await this.start(session)
      } catch (error) {
        await this.stop(session)
        throw error
      }
      session.mutating = false
    }
    this.assertRunning()
    this.authorize(workspace)
    if (this.pool.get(session.handle) !== session || !session.rpc)
      throw new Error('Session was closed while opening')
    this.current = session.snapshot
    this.preferences.activeWorkspace = workspace
    this.preferences.activeSession = session.snapshot.state.sessionFile
    await this.serial(() => this.persist())
    this.changed(session)
    return this.project(session)
  }
  private project(session: LiveSession): Snapshot {
    return {
      ...session.snapshot,
      state: {
        ...session.snapshot.state,
        isStreaming: this.status(session) === 'working',
        isCompacting: session.compacting || session.snapshot.state.isCompacting === true,
      },
      ui: [...session.ui.values(), ...session.pendingDialogs.values()],
    }
  }
  private async start(session: LiveSession) {
    this.assertRunning()
    const epoch = (session.epoch = ++this.epoch)
    session.snapshot.subagents = undefined
    session.rpc = new PiProcess(
      this.installation,
      session.snapshot.workspace,
      session.snapshot.state.sessionFile!,
      (record) => {
        if (session.epoch !== epoch || this.pool.get(session.handle) !== session) return
        const previousStatus = this.status(session)
        const tagged: PiRecord = {
          ...record,
          type: record.type.replace(/^auto_compaction_/, 'compaction_'),
          desktopSession: session.handle,
          desktopEpoch: epoch,
        }
        if (record.type === 'extension_ui_request' && record.method === 'setWidget' && record.widgetKey === SUBAGENT_STATUS_WIDGET) {
          const status = parseSubagentStatus(record.widgetLines?.[0])
          if (status) {
            session.snapshot.subagents = status
            this.event({ type: 'desktop_subagents_status', desktopSession: session.handle, desktopEpoch: epoch, status })
          }
          return
        }
        if (record.type === 'queue_update')
          session.snapshot.queued = { steering: record.steering, followUp: record.followUp }
        if (record.type === 'extension_ui_request') {
          if (['select', 'confirm', 'input', 'editor'].includes(record.method)) {
            if (typeof record.timeout === 'number') tagged.desktopExpiresAt = Date.now() + record.timeout
            session.pendingDialogs.set(record.id, tagged)
            if (typeof record.timeout === 'number') {
              const timer = setTimeout(
                () => {
                  if (session.pendingDialogs.get(record.id) !== tagged) return
                  session.pendingDialogs.delete(record.id)
                  this.changed(session)
                },
                Math.max(0, record.timeout),
              )
              timer.unref()
            }
          } else if (['setStatus', 'setWidget', 'set_editor_text', 'setEditorText'].includes(record.method)) {
            session.ui.set(`${record.method}:${record.statusKey || record.widgetKey || ''}`, tagged)
          }
        }
        if (record.type === 'agent_start') session.running = true
        if (record.type === 'agent_settled') {
          session.running = false
          session.settled++
        }
        if (tagged.type === 'compaction_start' || tagged.type === 'compaction_end') {
          session.compacting = tagged.type === 'compaction_start'
          session.snapshot.state.isCompacting = session.compacting
        }
        if (record.type === 'desktop_error') {
          void this.stop(session, false).finally(() => {
            session.mutating = false
            this.changed(session)
          })
        }
        this.event(tagged)
        if (this.status(session) !== previousStatus) this.changed(session)
      },
    )
    await this.refresh(session)
  }
  private async refresh(session: LiveSession): Promise<Snapshot> {
    const rpc = session.rpc,
      epoch = session.epoch
    if (!rpc) throw new Error('Pi is not running. Reopen the session.')
    const [state, history, levels, commands, models, stats] = await Promise.all([
      rpc.request('get_state'),
      rpc.request('get_messages'),
      rpc.request('get_available_thinking_levels').catch(() => ({ levels: [] })),
      rpc.request('get_commands'),
      rpc.request('get_available_models'),
      rpc.request('get_session_stats').catch(() => ({})),
    ])
    let todo = projectTodos(commands.commands || [])
    if (todo.availability !== 'disabled')
      todo = projectTodos(commands.commands || [], await rpc.request('get_entries').catch(() => undefined))
    if (epoch !== session.epoch || session.rpc !== rpc) throw new Error('Session changed')
    const duplicate = [...this.pool.values()].find(
      (s) => s !== session && s.rpc && s.snapshot.state.sessionFile === state.sessionFile,
    )
    if (duplicate) {
      await this.stop(session)
      throw new Error('Session already has a running writer')
    }
    const old = session.snapshot
    if (state.sessionFile)
      this.knownSessions.set(state.sessionFile, {
        workspace: old.workspace,
        info: {
          id: state.sessionId || session.handle,
          path: state.sessionFile,
          name: state.sessionName,
          firstMessage: '',
          modified: new Date().toISOString(),
          messageCount: history.messages.length,
        },
      })
    session.snapshot = {
      ...old,
      state,
      messages: history.messages,
      contextUsage: stats?.contextUsage,
      todo,
      levels: levels.levels,
      commands: commands.commands,
      models: models.models,
      ui: [...session.ui.values(), ...session.pendingDialogs.values()],
    }
    if (this.current?.handle === session.handle) this.current = session.snapshot
    this.updateCodexDemand()
    if (old.state.sessionFile !== state.sessionFile) this.changed(session)
    return this.project(session)
  }
  plugins(workspace?: string) {
    if (!this.installation) throw new Error('Pi is not connected')
    if (workspace !== undefined) this.authorize(workspace)
    return readPluginInventory(this.installation, workspace)
  }
  snapshot(handle?: string): Promise<Snapshot> {
    const session = this.selected(handle)
    return this.enqueue(session, () => this.refresh(session))
  }
  closeSession(handle: string) {
    const session = this.selected(handle)
    this.assertIdle(session)
    return this.enqueue(session, async () => {
      this.assertIdle(session)
      await this.stop(session)
      if (this.preferences.activeSession === session.snapshot.state.sessionFile) {
        delete this.preferences.activeSession
        delete this.preferences.activeWorkspace
        if (!this.shuttingDown) await this.serial(() => this.persist())
      }
    })
  }
  reload(handle?: string) {
    const session = this.selected(handle)
    this.assertIdle(session)
    return this.enqueue(session, async () => {
      this.assertIdle(session)
      session.mutating = true
      try {
        await this.stop(session, false)
        await this.start(session)
        this.changed(session)
        return this.project(session)
      } catch (error) {
        await this.stop(session, false)
        throw error
      } finally {
        session.mutating = false
      }
    })
  }
  deleteSession(workspace: string, path: string, stopWorking = false) {
    this.authorize(workspace)
    const session = [...this.pool.values()].find((s) => s.snapshot.state.sessionFile === path)
    if (session && !stopWorking) this.assertIdle(session)
    if (!session && this.pathChanges) throw new Error('A session path is changing; try again')
    if (this.deleting.has(path)) throw new Error('Session is being deleted')
    this.deleting.add(path)
    const remove = async () => {
      if (!(await this.sessions(workspace)).some((s) => s.path === path))
        throw new Error('Session does not belong to this workspace')
      if (!session && this.pathChanges) throw new Error('A session path is changing; try again')
      if (session) {
        if (!stopWorking) this.assertIdle(session)
        session.mutating = true
        await this.stop(session, false)
        // Forced deletion must bypass the in-flight command (it may await a dialog),
        // then wait for its finally/reconciliation before removing the native file.
        if (stopWorking) await session.queue
      }
      try {
        const exists = await stat(path).then(
          () => true,
          (error) => {
            if (error.code === 'ENOENT') return false
            throw error
          },
        )
        if (exists) await this.trashSession(path)
        this.knownSessions.delete(path)
        if (session) {
          this.pool.delete(session.handle)
          this.changed(session)
        }
        if (this.current?.state.sessionFile === path) this.current = undefined
        if (this.preferences.activeSession === path) {
          delete this.preferences.activeSession
          delete this.preferences.activeWorkspace
        }
        await this.serial(() => this.persist())
      } catch (error) {
        if (session && !this.shuttingDown) await this.start(session)
        throw error
      } finally {
        if (session) session.mutating = false
      }
    }
    return (session && !stopWorking ? this.enqueue(session, remove) : remove()).finally(() =>
      this.deleting.delete(path),
    )
  }
  async command(type: string, args: Record<string, unknown> = {}, handle?: string) {
    if (!allowed.has(type)) throw new Error(`Unsupported desktop operation: ${type}`)
    const session = this.selected(handle)
    if (
      ['prompt', 'steer', 'follow_up'].includes(type) &&
      (typeof args.message !== 'string' || args.message.length > 2_000_000)
    )
      throw new Error('Invalid prompt')
    if (
      type === 'set_session_name' &&
      (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 200)
    )
      throw new Error('Name must be 1–200 characters')
    const submissionVersion = session.submissionVersion
    if (type === 'clear_queue' || type === 'abort') session.submissionVersion++
    const changesPath = ['fork', 'clone'].includes(type)
    // Extension slash handlers can call native newSession/fork before returning.
    // Reserve unknown paths through reconciliation, including dialogs in withSession.
    const mayChangePath = changesPath || (type === 'prompt' && /^\s*\//.test(String(args.message)))
    if (changesPath) this.assertIdle(session)
    const run = async () => {
      this.assertRunning()
      if (!session.rpc) throw new Error('Pi is not running. Reopen the session.')
      this.authorize(session.snapshot.workspace)
      if (changesPath) {
        this.assertIdle(session)
        session.mutating = true
      }
      const beforeStatus = this.status(session)
      if (mayChangePath) this.pathChanges++
      if (type === 'prompt') session.prompts++
      if (type === 'compact') session.compacting = true
      if (this.status(session) !== beforeStatus) this.changed(session)
      const settled = session.settled
      let dispatched = false
      try {
        const { attachmentIds, ...nativeArgs } = args
        if (attachmentIds !== undefined) {
          if (
            !['prompt', 'steer', 'follow_up'].includes(type) ||
            !Array.isArray(attachmentIds) ||
            attachmentIds.some((id) => typeof id !== 'string')
          )
            throw new Error('Invalid attachment request')
          if (/^\s*\//.test(String(args.message)))
            throw new Error('Send attachments with a message, not a slash command')
          const prepared = await this.assets.prepare(
            session.snapshot.workspace,
            session.handle,
            attachmentIds as string[],
          )
          const model = session.snapshot.state.model
          if (prepared.images.length && model?.input && !model.input.includes('image'))
            throw new Error('This model does not support images. Select a vision-capable model first.')
          nativeArgs.message = [
            String(args.message || ''),
            'Attached workspace files (use native file tools when needed):',
            ...prepared.attachments.map((a) => JSON.stringify(a.path)),
          ].join('\n')
          if (prepared.images.length) nativeArgs.images = prepared.images
        }
        this.assertRunning()
        if (
          ['prompt', 'steer', 'follow_up'].includes(type) &&
          submissionVersion !== session.submissionVersion
        )
          throw new Error('Message cancelled before submission')
        // Once handed to native Pi, preserve files even if transport acknowledgement is lost.
        if (Array.isArray(attachmentIds))
          this.assets.retain(session.snapshot.workspace, session.handle, attachmentIds as string[])
        dispatched = true
        const rpc = session.rpc
        const result = await rpc.request(type, nativeArgs, type === 'compact' ? 600000 : 120000)
        if (type === 'set_model' && session.rpc === rpc) {
          session.snapshot = { ...session.snapshot, state: { ...session.snapshot.state, model: result } }
          if (this.current?.handle === session.handle) this.current = session.snapshot
          this.updateCodexDemand()
        }
        if (type === 'prompt' && result?.disposition !== 'handled' && session.settled === settled)
          session.running = true
        if (
          mayChangePath ||
          type === 'set_session_name' ||
          (type === 'prompt' && result?.disposition === 'handled')
        ) {
          await this.refresh(session)
          if (this.current?.handle === session.handle)
            this.preferences.activeSession = session.snapshot.state.sessionFile
          await this.serial(() => this.persist())
        }
        return result
      } catch (error) {
        // A failed refresh after native fork must not leave an untracked writer alive.
        if (changesPath && dispatched) await this.stop(session)
        else if (
          dispatched &&
          (type === 'prompt' || (type === 'compact' && (error as any)?.code !== 'PI_RESPONSE_REJECTED'))
        ) {
          await this.stop(session, false)
          session.mutating = false
        }
        throw error
      } finally {
        const beforeFinally = this.status(session)
        if (type === 'prompt') session.prompts--
        if (type === 'compact') session.compacting = false
        if (changesPath) session.mutating = false
        if (mayChangePath) this.pathChanges--
        if (this.status(session) !== beforeFinally || mayChangePath || type === 'set_session_name')
          this.changed(session)
      }
    }
    // Abort and dialogue responses must bypass an in-flight prompt/compaction.
    return ['abort', 'clear_queue', 'steer', 'follow_up', 'get_session_stats', 'get_entries'].includes(type)
      ? run()
      : this.enqueue(session, run)
  }
  async respond(record: PiRecord) {
    const session = this.selected(record.desktopSession)
    if (!record.desktopSession || !session.rpc || !session.pendingDialogs.has(record.id))
      throw new Error('This extension dialog is no longer active')
    await session.rpc.send({
      type: 'extension_ui_response',
      id: record.id,
      value: typeof record.value === 'string' ? record.value : undefined,
      confirmed: record.confirmed === true,
      cancelled: record.cancelled === true,
    })
    session.pendingDialogs.delete(record.id)
    this.changed(session)
  }
  private async stop(session: LiveSession, remove = true) {
    const rpc = session.rpc
    session.submissionVersion++
    session.mutating = true
    session.rpc = undefined
    this.updateCodexDemand()
    session.epoch = ++this.epoch
    session.pendingDialogs.clear()
    session.ui.clear()
    session.running = false
    session.compacting = false
    this.changed(session)
    // A concurrent close/error/shutdown must await the same process exit, even
    // after rpc has been detached from the session's command routing.
    const stopping = (session.stopping ||= rpc ? rpc.stop() : Promise.resolve())
    await stopping
    if (session.stopping === stopping) session.stopping = undefined
    if (remove) {
      await this.assets.cleanOwner(session.snapshot.workspace, session.handle)
      this.pool.delete(session.handle)
      if (this.current?.handle === session.handle) this.current = undefined
      this.changed(session)
    }
  }
  async close() {
    if (this.current) await this.closeSession(this.current.handle)
  }
  workspace(handle?: string) {
    if (handle) return this.selected(handle).snapshot.workspace
    if (!this.current) throw new Error('Open a workspace first')
    return this.current.workspace
  }
  importAttachments(handle: string, inputs: AttachmentInput[]) {
    return this.assets.import(this.workspace(handle), handle, inputs)
  }
  discardAttachment(handle: string, id: string) {
    return this.assets.discard(this.workspace(handle), handle, id)
  }
  fileOperation(handle: string, operation: FileOperation) {
    const workspace = this.workspace(handle)
    return this.serial(() => {
      if (this.workspace(handle) !== workspace) throw new Error('Workspace changed')
      return this.assets.operate(workspace, operation, this.trashSession)
    })
  }
  copyIntoWorkspace(workspace: string, directory: string, paths: string[]) {
    return this.serial(() => {
      this.authorize(workspace)
      return this.assets.operate(workspace, { type: 'copy', paths, directory }, this.trashSession)
    })
  }
  filePath(handle: string, path: string) {
    return assetPath(this.workspace(handle), path)
  }
  /** Display-only metadata for attachment cards; never reads file content. */
  async fileSizes(handle: string, paths: string[]) {
    if (
      !Array.isArray(paths) ||
      paths.length > 50 ||
      paths.some((path) => typeof path !== 'string' || !path || path.includes('\0'))
    )
      throw new Error('Invalid file list')
    const workspace = this.workspace(handle)
    const sizes = await Promise.all(
      paths.map(async (path) => {
        try {
          const info = await stat(await assetPath(workspace, path))
          return [path, info.isFile() ? info.size : null] as const
        } catch {
          return [path, null] as const
        }
      }),
    )
    return Object.fromEntries(sizes)
  }
  async files(path: string, handle?: string) {
    const result = await workspaceFsListDir({
      workspaceRoot: this.workspace(handle),
      path,
      includeDotfiles: true,
      maxEntries: 1000,
    })
    if (!result.ok) throw new Error(result.error)
    return result.entries
  }
  async readFile(path: string, handle?: string) {
    return this.readWorkspaceFile(this.workspace(handle), path)
  }
  private async readWorkspaceFile(workspace: string, path: string) {
    const result = await workspaceFsReadText({ workspaceRoot: workspace, path, maxBytes: 1024 * 1024 })
    if (!result.ok) throw new Error(result.error)
    if (result.truncated)
      throw new Error('Files larger than 1 MiB are not editable in this lightweight viewer')
    return { content: result.content, revision: digest(result.content) }
  }
  saveFile(path: string, content: string, revision: string, handle?: string) {
    const workspace = this.workspace(handle)
    return this.serial(async () => {
      if (this.workspace(handle) !== workspace) throw new Error('Workspace changed before saving')
      if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024)
        throw new Error('File exceeds 1 MiB')
      const resolved = await resolvePathUnderWorkspace(workspace, path)
      if (!resolved.ok) throw new Error(resolved.error)
      const before = await this.readWorkspaceFile(workspace, path)
      const conflict = () =>
        new Error('File changed on disk. Reopen it before saving; your draft has been kept.')
      if (before.revision !== revision) throw conflict()
      const metadata = await stat(resolved.abs)
      const temporary = `${resolved.abs}.pi-desktop-${randomUUID()}.tmp`
      try {
        const handle = await open(temporary, 'wx', metadata.mode)
        try {
          await handle.writeFile(content, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        if ((await this.readWorkspaceFile(workspace, path)).revision !== revision) throw conflict()
        await rename(temporary, resolved.abs)
      } finally {
        await unlink(temporary).catch(() => {})
      }
      return digest(content)
    })
  }
}
