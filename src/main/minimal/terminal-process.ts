import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import type * as pty from 'node-pty'

const nativeRequire = createRequire(import.meta.url)

const execFileAsync = promisify(execFile)
const MAX_INPUT_BYTES = 64 * 1024

type ProcessIdentity = { pid: number; ppid: number; pgid: number; session: number; tty: string; started: string }

export async function terminalProcessSnapshot(): Promise<ProcessIdentity[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,sess=,tty=,lstart='], { timeout: 1000, maxBuffer: 8 * 1024 * 1024 })
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), session: Number(match[4]), tty: match[5], started: match[6] }] : []
  })
}

const processes = terminalProcessSnapshot

function dimensions(cols: number, rows: number) {
  if (!Number.isInteger(cols) || cols < 1 || cols > 1000 || !Number.isInteger(rows) || rows < 1 || rows > 1000) {
    throw new RangeError('Terminal dimensions must be integers from 1 to 1000')
  }
}

/** Best-effort cleanup of descendants and same-session PTY members; detached daemons are not covered. PID identity checks cannot eliminate reuse races. */
export class TerminalProcess {
  private terminal: pty.IPty
  private identity: Promise<ProcessIdentity>
  private inspect: typeof processes
  private birthEarliest: number
  private birthLatest: number
  private closing?: Promise<void>
  private exited = false
  private exitPromise: Promise<void>
  readonly pid: number

  constructor(options: {
    file: string; args: string[]; cwd: string; env: Record<string, string | undefined>; cols: number; rows: number
    onData: (data: string) => void; onExit: (event: { exitCode: number; signal?: number }) => void
    inspect?: typeof processes
  }) {
    dimensions(options.cols, options.rows)
    // Load native code only when a terminal is actually opened, not on AI-only startup.
    const native = nativeRequire('node-pty') as typeof pty
    const beforeSpawn = Date.now()
    this.terminal = native.spawn(options.file, options.args, {
      cwd: options.cwd, env: options.env, cols: options.cols, rows: options.rows, name: 'xterm-256color',
    })
    this.birthEarliest = Math.floor(beforeSpawn / 1000) * 1000
    this.birthLatest = Math.floor(Date.now() / 1000) * 1000
    this.inspect = options.inspect || processes
    this.pid = this.terminal.pid
    // lstart has one-second resolution. A retried inspection must still fit the
    // original native spawn interval, never adopt an arbitrary later PID owner.
    this.identity = this.captureIdentity()
    // Observe failure immediately even if close is called much later.
    void this.identity.catch(() => {})
    this.terminal.onData(options.onData)
    this.exitPromise = new Promise(resolve => {
      this.terminal.onExit(event => { this.exited = true; resolve(); options.onExit(event) })
    })
  }

  write(data: string) {
    if (this.closing || this.exited) throw new Error('Terminal is closed')
    if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_INPUT_BYTES) throw new RangeError('Terminal input exceeds 64 KiB or is not a string')
    this.terminal.write(data)
  }

  resize(cols: number, rows: number) {
    if (this.closing || this.exited) throw new Error('Terminal is closed')
    dimensions(cols, rows)
    this.terminal.resize(cols, rows)
  }

  pause() { if (!this.closing && !this.exited) this.terminal.pause() }
  resume() { if (!this.closing && !this.exited) this.terminal.resume() }

  close(): Promise<void> {
    if (!this.closing) {
      const attempt = this.cleanup().catch(error => { this.closing = undefined; throw error })
      this.closing = attempt
    }
    return this.closing
  }

  private async captureIdentity() {
    const root = (await this.inspect()).find(item => item.pid === this.pid)
    if (!root) throw new Error('Terminal process identity unavailable')
    if (Date.parse(root.started) < this.birthEarliest || Date.parse(root.started) > this.birthLatest || !Number.isFinite(Date.parse(root.started))) throw new Error('Terminal process identity changed')
    return root
  }

  private async cleanup() {
    let root: ProcessIdentity | undefined
    let snapshot: ProcessIdentity[]
    try {
      try { root = await this.identity } catch {
        if (this.exited) throw new Error('Terminal ownership unavailable after shell exit; cleanup unresolved')
        this.identity = this.captureIdentity()
        root = await this.identity
      }
      snapshot = await processes()
    } catch (error) {
      // Root exit is not proof that unknown descendants exited. Keep inspection
      // failure visible and retained; never signal an unverified replacement PID.
      // Closing the owned PTY master sends a hangup without signalling a possibly reused PID.
      // node-pty's public destroy() additionally signals its stored PID, so do not use it here.
      ;(this.terminal as unknown as { _socket: { destroy(): void } })._socket.destroy()
      throw error
    }
    const rootAlive = snapshot.some(p => p.pid === root!.pid && p.started === root!.started)
    const owned = new Map<number, ProcessIdentity>()
    if (rootAlive) owned.set(root.pid, root)
    // A terminal session can outlive its shell. Only consider its original controlling
    // TTY and session, and still verify each PID's birth time immediately before signalling.
    if (root.session && root.tty !== '??' && root.tty !== '?') {
      for (const item of snapshot) {
        if (item.session === root.session && item.tty === root.tty && Date.parse(item.started) >= Date.parse(root.started)) owned.set(item.pid, item)
      }
    }
    // On macOS ps may hide session/TTY metadata. A process group remains allocated
    // while members survive, even after its leader exits. Reject a reused leader;
    // group and per-PID birth checks remain best effort against subsequent reuse.
    const groupLeader = snapshot.find(item => item.pid === root!.pgid)
    if (root.pgid === root.pid && (!groupLeader || groupLeader.started === root.started)) {
      for (const item of snapshot) {
        if (item.pgid === root.pgid && Date.parse(item.started) >= Date.parse(root.started)) owned.set(item.pid, item)
      }
    }
    // Snapshot individual descendants (including their process groups) before any HUP.
    let changed = true
    while (changed) {
      changed = false
      for (const item of snapshot) {
        if (!owned.has(item.pid) && owned.has(item.ppid)) { owned.set(item.pid, item); changed = true }
      }
    }
    for (const signal of ['SIGHUP', 'SIGTERM', 'SIGKILL'] as const) {
      let current: ProcessIdentity[]
      try { current = await processes() } catch (error) {
        ;(this.terminal as unknown as { _socket: { destroy(): void } })._socket.destroy()
        throw error
      }
      // Signal only identified descendants, never whole groups that could include unrelated processes.
      for (const item of [...owned.values()].reverse()) {
        if (!current.some(p => p.pid === item.pid && p.started === item.started)) continue
        try { process.kill(item.pid, signal) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      if (signal !== 'SIGKILL') await new Promise(resolve => setTimeout(resolve, 150))
    }
    await this.waitForExit()
  }

  private async waitForExit() {
    if (this.exited) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.exitPromise,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Terminal did not exit')), 1000) }),
      ])
    } finally { if (timer) clearTimeout(timer) }
  }
}
