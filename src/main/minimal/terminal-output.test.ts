import { describe, expect, it, vi } from 'vitest'
import { TerminalOutputPump, type TerminalPacket } from './terminal-output'

describe('TerminalOutputPump', () => {
  it('waits for attach and preserves ordered Unicode across packet boundaries and cumulative ACKs', () => {
    vi.useFakeTimers()
    try {
      const packets: TerminalPacket[] = []
      const flow = { pause: vi.fn(), resume: vi.fn() }
      const fatal = vi.fn()
      const pump = new TerminalOutputPump(flow, packet => packets.push(packet), fatal)
      const input = 'a'.repeat(16383) + '😀' + '界'.repeat(100000)
      pump.push(input)
      vi.runAllTimers()
      expect(packets).toEqual([])
      pump.attach()
      vi.runAllTimers()
      expect(packets.map(p => p.data).join('').length).toBeLessThan(input.length)
      expect(packets.map(p => p.sequence)).toEqual(packets.map((_, i) => i + 1))
      expect(packets.every(p => Buffer.byteLength(p.data) <= 16384)).toBe(true)
      pump.ack(packets.at(-1)!.sequence)
      vi.runAllTimers()
      expect(packets.map(p => p.data).join('')).toBe(input)
      expect(fatal).not.toHaveBeenCalled()
      pump.close()
    } finally { vi.useRealTimers() }
  })

  it('pauses and resumes with hysteresis, rejects overload and invalid ACKs once', () => {
    vi.useFakeTimers()
    try {
      const flow = { pause: vi.fn(), resume: vi.fn() }
      const fatal = vi.fn()
      const pump = new TerminalOutputPump(flow, () => {}, fatal)
      pump.push('x'.repeat(180000))
      expect(flow.pause).toHaveBeenCalledOnce()
      pump.attach(); vi.runAllTimers()
      pump.ack(1); vi.runAllTimers()
      pump.ack(100000)
      expect(fatal).toHaveBeenCalledOnce()
      expect(flow.resume).toHaveBeenCalledOnce()
      pump.close(); pump.ack(-1)
      expect(fatal).toHaveBeenCalledOnce()
      const overload = new TerminalOutputPump(flow, () => {}, fatal)
      overload.push('x'.repeat(700000))
      expect(fatal).toHaveBeenCalledTimes(2)
      overload.close()
    } finally { vi.useRealTimers() }
  })

  it('resumes after ACKs drain below the low watermark', () => {
    vi.useFakeTimers()
    try {
      const flow = { pause: vi.fn(), resume: vi.fn() }
      const packets: TerminalPacket[] = []
      const pump = new TerminalOutputPump(flow, packet => packets.push(packet), () => {})
      pump.push('x'.repeat(180000)); expect(flow.pause).toHaveBeenCalledOnce()
      pump.attach(); vi.runAllTimers(); pump.ack(packets.at(-1)!.sequence); vi.runAllTimers()
      expect(flow.resume).toHaveBeenCalledOnce()
      pump.close()
    } finally { vi.useRealTimers() }
  })

  it('holds a split surrogate pair and flushes a final unpaired surrogate on finish', () => {
    vi.useFakeTimers()
    try {
      const packets: TerminalPacket[] = []
      const pump = new TerminalOutputPump({ pause() {}, resume() {} }, packet => packets.push(packet), () => {})
      pump.attach(); pump.push('a\ud83d'); vi.runAllTimers()
      expect(packets.map(p => p.data).join('')).toBe('a')
      pump.push('\ude00\ud800'); vi.runAllTimers()
      expect(packets.map(p => p.data).join('')).toBe('a😀')
      pump.finish(); vi.runAllTimers()
      expect(packets.map(p => p.data).join('')).toBe('a😀\ud800')
      pump.close()
    } finally { vi.useRealTimers() }
  })

  it('cancels a scheduled flush on close and accepts duplicate ACKs', () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn(); const fatal = vi.fn()
      const pump = new TerminalOutputPump({ pause() {}, resume() {} }, send, fatal)
      pump.attach(); pump.push('test'); pump.close(); vi.runAllTimers()
      expect(send).not.toHaveBeenCalled()
      expect(fatal).not.toHaveBeenCalled()
      const next = new TerminalOutputPump({ pause() {}, resume() {} }, send, fatal)
      next.attach(); next.push('ok'); vi.runAllTimers(); next.ack(1); next.ack(1)
      expect(fatal).not.toHaveBeenCalled()
      next.close()
    } finally { vi.useRealTimers() }
  })
})
