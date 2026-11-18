import { randomBytes, randomInt } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export type TerminalChannelEvent =
  | { type: 'init'; context: string; mode: 'fixed' | 'direct'; generation: number; cwd: string }
  | { type: 'finish'; context: string; generation: number }
  | { type: 'running'; generation: number }
export type TerminalChannelResponse = { generation?: number; cursor?: number; buffer?: string; options?: { cursor: number; buffer: string }[] }
type Action = 'c' | 's' | 'x' | 'd' | 'g' | 'k'
type Pending = { action: Action; resolve: (response: TerminalChannelResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; bytes: number; response: TerminalChannelResponse; nextOption: number; truncated: boolean }
const FRAME_LIMIT = 16 * 1024
const RESPONSE_LIMIT = 1024 * 1024
const REQUEST_LIMIT = 4096
const integer = (s: string) => /^(0|[1-9][0-9]{0,9})$/.test(s) && Number(s) <= 1_000_000_000
const generationNumber = (s: string) => integer(s) && Number(s) > 0

export function terminalCursorToNative(buffer: string, cursor: number): number {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > buffer.length ||
      (cursor > 0 && cursor < buffer.length && /[\uD800-\uDBFF]/.test(buffer[cursor - 1]) && /[\uDC00-\uDFFF]/.test(buffer[cursor]))) throw new Error('Invalid terminal cursor')
  return Array.from(buffer.slice(0, cursor)).length
}
export function terminalCursorFromNative(buffer: string, cursor: number): number {
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error('Invalid terminal cursor')
  const chars = Array.from(buffer)
  if (cursor > chars.length) throw new Error('Invalid terminal cursor')
  return chars.slice(0, cursor).join('').length
}
function encode(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > REQUEST_LIMIT || text.includes('\0') || bytes.toString('utf8') !== text) throw new Error('Invalid terminal input')
  return bytes.toString('hex')
}
function decode(hex: string): string {
  if (hex.length > REQUEST_LIMIT * 2 || !/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error('Invalid terminal frame')
  const bytes = Buffer.from(hex, 'hex')
  const text = bytes.toString('utf8')
  if (text.includes('\0') || !Buffer.from(text).equals(bytes)) throw new Error('Invalid terminal frame')
  return text
}

/** Private socket protocol. A malformed authenticated peer fails the entire channel. */
export class TerminalChannel {
  readonly token = randomBytes(24).toString('hex')
  readonly dispatch = `\x1b[6973;${randomInt(100_000_000, 1_000_000_000)}~`
  private dispatcher?: (generation: number) => void
  private server!: Server
  private socket?: Socket
  private sockets = new Set<Socket>()
  private expectedPid?: number
  private closed = false
  private directoryCleanup?: Promise<void>
  private nextId = 0
  private pending = new Map<number, Pending>()
  private expired = new Set<number>()
  private constructor(readonly directory: string, readonly path: string, private event: (event: TerminalChannelEvent) => void, private failed: () => void) {}

  static async create(event: (event: TerminalChannelEvent) => void, failed: () => void): Promise<TerminalChannel> {
    // Keep under Darwin's short sockaddr_un limit even when TMPDIR is long.
    const directory = await mkdtemp(join(tmpdir().length < 50 ? tmpdir() : '/tmp', 'pt-'))
    await chmod(directory, 0o700)
    const channel = new TerminalChannel(directory, join(directory, 's'), event, failed)
    channel.server = createServer(socket => channel.accept(socket))
    channel.server.maxConnections = 16
    try {
      await new Promise<void>((resolve, reject) => {
        channel.server.once('error', reject)
        channel.server.listen(channel.path, () => { channel.server.off('error', reject); resolve() })
      })
      channel.server.on('error', () => channel.fail())
      return channel
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  }

  expectPid(pid: number) { this.expectedPid = pid }
  setDispatcher(wake: (generation: number) => void) {
    if (typeof wake !== 'function') throw new TypeError('Invalid terminal dispatcher')
    this.dispatcher = wake
  }
  get connected() { return !!this.socket && !this.closed }

  private accept(socket: Socket) {
    if (this.closed || this.socket) { socket.destroy(); return }
    this.sockets.add(socket)
    let buffer = Buffer.alloc(0)
    let authenticated = false
    const timer = setTimeout(() => socket.destroy(), 2000)
    socket.on('error', () => { if (authenticated) this.fail() })
    socket.on('close', () => { this.sockets.delete(socket); clearTimeout(timer); if (authenticated && !this.closed) this.fail() })
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (true) {
        const end = buffer.indexOf(10)
        if (end < 0) { if (buffer.length > FRAME_LIMIT) { if (authenticated) this.fail(); else socket.destroy() }; return }
        if (end > FRAME_LIMIT) { if (authenticated) this.fail(); else socket.destroy(); return }
        const frame = buffer.subarray(0, end)
        if (frame.some(byte => byte < 0x20 || byte > 0x7e)) { if (authenticated) this.fail(); else socket.destroy(); return }
        const line = frame.toString('ascii')
        buffer = buffer.subarray(end + 1)
        if (!authenticated) {
          if (line !== `0;hello;1;${this.token};${this.expectedPid}` || !this.expectedPid || this.socket) { socket.destroy(); return }
          authenticated = true; this.socket = socket; clearTimeout(timer)
        } else {
          try { this.receive(line, end + 1) } catch { this.fail(); return }
        }
      }
    })
  }

  request(action: Action, text: string, cursor: number, generation: number, timeout = 1500): { id: number; promise: Promise<TerminalChannelResponse> } {
    if (!this.connected || !this.dispatcher || this.nextId >= 1_000_000_000 || !Number.isSafeInteger(generation) || generation < 1 || generation > 1_000_000_000) throw new Error('Terminal channel unavailable')
    const hex = encode(text)
    const nativeCursor = terminalCursorToNative(text, cursor)
    const id = ++this.nextId
    const promise = new Promise<TerminalChannelResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.expire(id, new Error('Terminal request timed out'))
        this.fail()
      }, timeout)
      this.pending.set(id, { action, resolve, reject, timer, bytes: 0, response: {}, nextOption: 1, truncated: false })
      const socket = this.socket!
      try {
        // The helper drains the full bounded frame in its key widget. Waiting for
        // this write's callback before waking can deadlock on a full socket buffer.
        socket.write(`${id}:${action}:${nativeCursor}:${generation}:${hex}\n`, error => {
          if (error && !this.closed) this.fail()
        })
        if (this.closed || this.socket !== socket || !this.pending.has(id)) return
        if (socket.destroyed) { this.fail(); return }
        this.dispatcher!(generation)
      } catch {
        this.expire(id, new Error('Terminal dispatch failed'))
        this.fail()
      }
    })
    return { id, promise }
  }

  private receive(line: string, bytes: number) {
    if (!/^[\x20-\x7e]*$/.test(line)) throw new Error('Invalid terminal frame')
    const fields = line.split(';')
    if (!integer(fields[0])) throw new Error('Invalid terminal frame')
    const id = Number(fields[0])
    if (!id) {
      const [, kind, ...rest] = fields
      if (kind === 'init' && rest.length === 4 && /^[a-z-]{1,32}$/.test(rest[0]) && (rest[1] === 'fixed' || rest[1] === 'direct') && generationNumber(rest[2])) {
        this.event({ type: 'init', context: rest[0], mode: rest[1], generation: Number(rest[2]), cwd: decode(rest[3]) }); return
      }
      if (kind === 'finish' && rest.length === 2 && /^[a-z-]{1,32}$/.test(rest[0]) && generationNumber(rest[1])) { this.event({ type: 'finish', context: rest[0], generation: Number(rest[1]) }); return }
      if (kind === 'running' && rest.length === 1 && generationNumber(rest[0])) { this.event({ type: 'running', generation: Number(rest[0]) }); return }
      throw new Error('Invalid terminal event')
    }
    const pending = this.pending.get(id)
    if (!pending) { if (this.expired.has(id)) return; throw new Error('Unexpected terminal response') }
    pending.bytes += bytes
    if (pending.bytes > RESPONSE_LIMIT) throw new Error('Terminal response too large')
    const [, kind, ...args] = fields
    if (kind === 'error' && args.length === 1 && /^[a-z-]{1,40}$/.test(args[0])) { this.complete(id, undefined, new Error('Terminal operation rejected')); return }
    const snapshot = (cursor: string, hex: string) => {
      if (!integer(cursor)) throw new Error('Invalid terminal cursor')
      const buffer = decode(hex)
      return { buffer, cursor: terminalCursorFromNative(buffer, Number(cursor)) }
    }
    if (pending.action === 'c') {
      if (kind === 'result' && args.length === 2 && pending.response.buffer === undefined) { Object.assign(pending.response, snapshot(args[0], args[1])); return }
      if (kind === 'option' && args.length === 3 && pending.response.buffer !== undefined && !pending.truncated && integer(args[0]) && Number(args[0]) === pending.nextOption && pending.nextOption <= 64) {
        ;(pending.response.options ||= []).push(snapshot(args[1], args[2])); pending.nextOption++; return
      }
      if (kind === 'truncated' && args.length === 1 && pending.response.buffer !== undefined && !pending.truncated && integer(args[0]) && Number(args[0]) >= pending.nextOption - 1) { pending.truncated = true; return }
      if (kind === 'done' && args.length === 1 && generationNumber(args[0]) && pending.response.buffer !== undefined) { pending.response.generation = Number(args[0]); this.complete(id, pending.response); return }
    } else if (pending.action === 'g' && kind === 'snapshot' && args.length === 3 && generationNumber(args[2])) {
      this.complete(id, { ...snapshot(args[0], args[1]), generation: Number(args[2]) }); return
    } else if (kind === ({ s: 'loaded', x: 'cancelled', d: 'direct' } as Partial<Record<Action, string>>)[pending.action] && args.length === 1 && generationNumber(args[0])) {
      this.complete(id, { generation: Number(args[0]) }); return
    } else if (pending.action === 'k' && kind === 'interrupt' && args.length === 1 && generationNumber(args[0])) {
      this.complete(id, { generation: Number(args[0]) }); return
    }
    throw new Error('Invalid terminal response')
  }

  private expire(id: number, error: Error) {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id); clearTimeout(pending.timer); this.expired.add(id)
    pending.reject(error)
    if (this.expired.size > 128) this.fail()
  }

  private complete(id: number, response?: TerminalChannelResponse, error?: Error) {
    const pending = this.pending.get(id)!
    this.pending.delete(id); clearTimeout(pending.timer)
    if (error) pending.reject(error); else pending.resolve(response!)
  }
  private fail() { if (!this.closed) { void this.close().catch(() => {}); this.failed() } }
  async close() {
    if (!this.closed) {
      this.closed = true
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Terminal channel closed')) }
      this.pending.clear()
      for (const socket of this.sockets) socket.destroy()
      this.server.close()
    }
    if (!this.directoryCleanup) this.directoryCleanup = rm(this.directory, { recursive: true, force: true }).catch(error => {
      this.directoryCleanup = undefined
      throw error
    })
    await this.directoryCleanup
  }
}
