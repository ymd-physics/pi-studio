export type TerminalPacket = { sequence: number; data: string }

const PACKET_BYTES = 16 * 1024
const CREDIT_BYTES = 256 * 1024
const PAUSE_BYTES = 512 * 1024
const RESUME_BYTES = 256 * 1024
const HARD_BYTES = 2 * 1024 * 1024

/** Ordered, cumulative-ACK output. The pending limit conservatively counts three bytes per UTF-16 code unit. */
export class TerminalOutputPump {
  private pending = ''
  private outstanding: { sequence: number; bytes: number }[] = []
  private outstandingBytes = 0
  private sequence = 0
  private acked = 0
  private attached = false
  private finished = false
  private drained = false
  private paused = false
  private closed = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private flow: { pause(): void; resume(): void },
    private send: (packet: TerminalPacket) => void,
    private fatal: (error: Error) => void,
    private onDrained: () => void = () => {},
  ) {}

  attach() {
    if (this.closed || this.attached) return
    this.attached = true
    this.schedule()
  }

  push(data: string) {
    if (this.closed || !data) return
    if (this.finished) { this.fail(new Error('Terminal output after finish')); return }
    // Three bytes per code unit is an upper bound even across surrogate boundaries.
    if (this.pending.length * 3 + data.length * 3 + this.outstandingBytes > HARD_BYTES) {
      this.fail(new Error('Terminal output exceeded the 2 MiB budget'))
      return
    }
    this.pending += data
    this.watermark()
    this.schedule()
  }

  /** Flush a final unpaired high surrogate after the PTY has exited. */
  finish() {
    if (this.closed || this.finished) return
    this.finished = true
    this.schedule()
    this.checkDrained()
  }

  ack(sequence: number) {
    if (this.closed) return
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.sequence) {
      this.fail(new Error('Invalid terminal output ACK'))
      return
    }
    if (sequence <= this.acked) return
    this.acked = sequence
    while (this.outstanding.length && this.outstanding[0].sequence <= sequence) {
      this.outstandingBytes -= this.outstanding.shift()!.bytes
    }
    this.watermark()
    this.schedule()
    this.checkDrained()
  }

  close() {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending = ''
    this.outstanding = []
    this.outstandingBytes = 0
    if (this.paused) { this.paused = false; this.flow.resume() }
  }

  private checkDrained() {
    if (this.finished && !this.closed && !this.drained && !this.pending && !this.outstanding.length) {
      this.drained = true
      this.onDrained()
    }
  }

  private fail(error: Error) {
    this.close()
    this.fatal(error)
  }

  private watermark() {
    const bytes = this.pending.length * 3 + this.outstandingBytes
    if (!this.paused && bytes >= PAUSE_BYTES) { this.paused = true; this.flow.pause() }
    else if (this.paused && bytes <= RESUME_BYTES) { this.paused = false; this.flow.resume() }
  }

  private schedule() {
    if (this.closed || !this.attached || !this.pending || this.timer || this.outstandingBytes >= CREDIT_BYTES) return
    this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, 0)
  }

  private flush() {
    while (!this.closed && this.pending && this.outstandingBytes < CREDIT_BYTES) {
      const limit = Math.min(PACKET_BYTES, CREDIT_BYTES - this.outstandingBytes)
      // UTF-8 uses at least one byte per code unit except a surrogate pair (four bytes for two).
      // Binary search bounds work per packet and avoids a byteLength call per character.
      let low = 0, high = Math.min(this.pending.length, limit)
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (Buffer.byteLength(this.pending.slice(0, middle)) <= limit) low = middle
        else high = middle - 1
      }
      let end = low
      const last = this.pending.charCodeAt(end - 1)
      const next = this.pending.charCodeAt(end)
      if (last >= 0xd800 && last <= 0xdbff &&
        ((next >= 0xdc00 && next <= 0xdfff) || (end === this.pending.length && !this.finished))) end--
      if (!end) break
      const data = this.pending.slice(0, end)
      const bytes = Buffer.byteLength(data)
      this.pending = this.pending.slice(end)
      const sequence = ++this.sequence
      this.outstanding.push({ sequence, bytes })
      this.outstandingBytes += bytes
      try { this.send({ sequence, data }) } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
    }
    this.watermark()
    this.checkDrained()
  }
}
