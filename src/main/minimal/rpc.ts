import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { randomUUID } from 'node:crypto'
import { dirname, delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PiRecord } from '../../../packages/shared/desktop'
import type { PiInstallation } from './runtime'
import { usesNativeRpcBridge } from './rpc-version'

/** Strict LF framing (readline incorrectly splits valid Unicode separators). */
export class JsonLines {
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  constructor(private receive: (record: PiRecord) => void) {}
  push(chunk: Buffer) {
    this.buffer += this.decoder.write(chunk)
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '')
      this.buffer = this.buffer.slice(end + 1)
      if (line) this.receive(JSON.parse(line))
    }
    if (this.buffer.length > 32 * 1024 * 1024) throw new Error('Pi RPC record exceeds 32 MiB')
  }
}

export class PiProcess {
  private child: ChildProcessWithoutNullStreams
  private pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private stderr = ''
  private stopped = false
  private closing = false
  private exited: Promise<void>
  private writes: Promise<void> = Promise.resolve()

  constructor(
    installation: PiInstallation,
    cwd: string,
    session: string,
    private event: (record: PiRecord) => void,
  ) {
    const env = { ...process.env }
    env.PATH = `${dirname(installation.node)}${delimiter}${env.PATH || ''}`
    // Do not inherit Electron's Node mode or the supervising agent's session identity.
    delete env.ELECTRON_RUN_AS_NODE
    for (const key of ['PI_SESSION_ID', 'PI_SESSION_FILE']) delete env[key]
    const guard = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../resources/desktop-session-guard.mjs',
    ).replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
    const args = usesNativeRpcBridge(installation.version)
      ? [join(dirname(guard), 'desktop-rpc.mjs'), installation.sdk, session]
      : [installation.cli, '--mode', 'rpc', '--approve', '--extension', guard, '--session', session]
    this.child = spawn(installation.node, args, {
      cwd,
      env,
      stdio: 'pipe',
      windowsHide: true,
    })
    const lines = new JsonLines((record) => {
      if (record.type === 'response' && record.id && this.pending.has(record.id)) {
        const pending = this.pending.get(record.id)!
        clearTimeout(pending.timer)
        this.pending.delete(record.id)
        if (record.success) pending.resolve(record.data)
        else
          pending.reject(
            Object.assign(new Error(record.error || `Pi rejected ${record.command}`), {
              code: 'PI_RESPONSE_REJECTED',
            }),
          )
      } else this.event(record)
    })
    this.child.stdout.on('data', (chunk) => {
      try {
        lines.push(chunk)
      } catch (error) {
        this.fail(error as Error)
        this.child.kill()
      }
    })
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-12000)
      if (!this.closing) this.event({ type: 'desktop_diagnostic', message: this.stderr })
    })
    this.exited = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        this.stopped = true
        const error = new Error(`Pi exited (${signal || code}). ${this.stderr}`)
        this.fail(error)
        if (!this.closing) this.event({ type: 'desktop_error', message: error.message })
        resolve()
      })
    })
    this.child.on('error', (error) => {
      this.fail(error)
      this.event({ type: 'desktop_error', message: error.message })
    })
    this.child.stdin.on('error', (error) => this.fail(error))
  }

  private fail(error: Error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  send(record: PiRecord): Promise<void> {
    const write = this.writes.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.stopped || this.child.stdin.destroyed) return reject(new Error('Pi is not running'))
          this.child.stdin.write(JSON.stringify(record) + '\n', (error) =>
            error ? reject(error) : resolve(),
          )
        }),
    )
    this.writes = write.catch(() => {})
    return write
  }

  request(type: string, args: Record<string, unknown> = {}, timeout = 120000): Promise<any> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi timed out handling ${type}. Stop the operation or reopen the session.`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      void this.send({ ...args, type, id }).catch((error) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  async stop() {
    if (this.stopped) return
    this.closing = true
    await this.request('clear_queue', {}, 2000).catch(() => {})
    // Standalone RPC bash is not covered by agent abort. Both must be cancelled.
    await Promise.allSettled([this.request('abort_bash', {}, 3000), this.request('abort', {}, 3000)])
    // Native SIGTERM sweeps tracked detached tool groups BEFORE extension shutdown.
    // EOF does not, and removes signal handlers before potentially hanging hooks.
    if (!this.stopped) this.child.kill('SIGTERM')
    const kill = setTimeout(() => {
      if (!this.stopped) this.child.kill('SIGKILL')
    }, 5000)
    try {
      await this.exited
    } finally {
      clearTimeout(kill)
    }
  }
}
