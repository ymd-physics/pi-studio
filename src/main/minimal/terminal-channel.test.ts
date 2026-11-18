import { connect, type Socket } from 'node:net'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import { TerminalChannel, terminalCursorFromNative, terminalCursorToNative } from './terminal-channel'

async function peer(channel: TerminalChannel, configureDispatcher = true): Promise<Socket> {
  if (configureDispatcher) channel.setDispatcher(() => {})
  const socket = connect(channel.path)
  await once(socket, 'connect')
  socket.write(`0;hello;1;${channel.token};123\n`)
  await new Promise(resolve => setTimeout(resolve, 10))
  return socket
}

it('authenticates, converts cursor units, and parses bounded completion records', async () => {
  expect(terminalCursorToNative('a😀b', 3)).toBe(2)
  expect(terminalCursorFromNative('a😀b', 2)).toBe(3)
  expect(() => terminalCursorToNative('a😀b', 2)).toThrow()
  const events: any[] = []
  const failed = vi.fn()
  const channel = await TerminalChannel.create(e => events.push(e), failed)
  channel.expectPid(123)
  const socket = await peer(channel)
  try {
    socket.write(`0;init;start;fixed;1;${Buffer.from('/tmp').toString('hex')}\n`)
    const received = once(socket, 'data')
    const request = channel.request('c', '😀x', 2, 1)
    expect((await received)[0].toString()).toBe('1:c:1:1:f09f988078\n')
    socket.write(`1;result;1;f09f988078\n1;option;1;2;f09f988078\n1;done;1\n`)
    await expect(request.promise).resolves.toEqual({ buffer: '😀x', cursor: 2, options: [{ buffer: '😀x', cursor: 3 }], generation: 1 })
    expect(events[0]).toMatchObject({ type: 'init', generation: 1, cwd: '/tmp' })
    expect(failed).not.toHaveBeenCalled()
    expect(() => channel.request('s', '\0', 0, 1)).toThrow()
    expect(() => channel.request('s', 'a'.repeat(4097), 0, 1)).toThrow()
  } finally { socket.destroy(); await channel.close() }
})

function deferChannelWrites(channel: TerminalChannel) {
  const socket = (channel as unknown as { socket: Socket }).socket
  const callbacks: ((error?: Error | null) => void)[] = []
  const frames: string[] = []
  vi.spyOn(socket, 'write').mockImplementation(((frame: string, callback: (error?: Error | null) => void) => {
    frames.push(frame); callbacks.push(callback); return true
  }) as Socket['write'])
  return { callbacks, frames }
}

it('wakes exactly once after write returns and before its delayed callback', async () => {
  const channel = await TerminalChannel.create(() => {}, () => {})
  channel.expectPid(123)
  const socket = await peer(channel, false)
  try {
    expect(channel.dispatch).toMatch(/^\x1b\[6973;[1-9][0-9]{8}~$/)
    expect(() => channel.request('s', 'secret', 6, 41)).toThrow('unavailable')
    const wake = vi.fn()
    channel.setDispatcher(wake)
    const writes = deferChannelWrites(channel)
    const request = channel.request('s', 'secret', 6, 41)
    expect(writes.frames).toEqual(['1:s:6:41:736563726574\n'])
    expect(wake).toHaveBeenCalledExactlyOnceWith(41)
    writes.callbacks[0]()
    expect(wake).toHaveBeenCalledExactlyOnceWith(41)
    socket.write('1;loaded;41\n')
    await expect(request.promise).resolves.toEqual({ generation: 41 })
  } finally { socket.destroy(); await channel.close() }
})

it('never wakes again after timeout or close when its write callback arrives later', async () => {
  for (const reason of ['timeout', 'close']) {
    const channel = await TerminalChannel.create(() => {}, () => {})
    channel.expectPid(123)
    const socket = await peer(channel)
    const wake = vi.fn(); channel.setDispatcher(wake)
    const writes = deferChannelWrites(channel)
    try {
      const request = channel.request('s', 'test', 4, 7, 20)
      const rejection = expect(request.promise).rejects.toThrow()
      expect(wake).toHaveBeenCalledExactlyOnceWith(7)
      if (reason === 'close') await channel.close()
      await rejection
      expect(channel.connected).toBe(false)
      writes.callbacks[0]()
      expect(wake).toHaveBeenCalledExactlyOnceWith(7)
    } finally { socket.destroy(); await channel.close() }
  }
})

it('expires a failed wake, rejects all pending work, and closes before another wake', async () => {
  const failed = vi.fn()
  const channel = await TerminalChannel.create(() => {}, failed)
  channel.expectPid(123)
  const socket = await peer(channel)
  const writes = deferChannelWrites(channel)
  try {
    const wake = vi.fn((generation: number) => { if (generation === 10) throw new Error('stale session') })
    channel.setDispatcher(wake)
    const old = channel.request('c', '', 0, 9)
    const next = channel.request('s', 'secret', 6, 10)
    const rejected = expect(next.promise).rejects.toThrow('Terminal dispatch failed')
    const oldRejected = expect(old.promise).rejects.toThrow('closed')
    await Promise.all([rejected, oldRejected])
    expect(failed).toHaveBeenCalledOnce()
    expect(channel.connected).toBe(false)
    expect(() => channel.request('s', 'other', 5, 9)).toThrow('unavailable')
    writes.callbacks[0](); writes.callbacks[1]()
    expect(wake).toHaveBeenCalledTimes(2)
    // An already-delivered late frame for the expired ID remains harmless.
    expect(() => (channel as unknown as { receive(line: string, bytes: number): void }).receive('2;loaded;10', 12)).not.toThrow()
  } finally { socket.destroy(); await channel.close() }
})

it('fails closed on a late socket write failure without another wake', async () => {
  const failed = vi.fn()
  const channel = await TerminalChannel.create(() => {}, failed)
  channel.expectPid(123)
  const socket = await peer(channel)
  const wake = vi.fn(); channel.setDispatcher(wake)
  const writes = deferChannelWrites(channel)
  try {
    const request = channel.request('s', 'test', 4, 3)
    const rejection = expect(request.promise).rejects.toThrow()
    writes.callbacks[0](new Error('write failed'))
    await rejection
    expect(wake).toHaveBeenCalledExactlyOnceWith(3)
    expect(failed).toHaveBeenCalledOnce()
  } finally { socket.destroy(); await channel.close() }
})

it('fails closed without waking if socket.write throws synchronously', async () => {
  const failed = vi.fn()
  const channel = await TerminalChannel.create(() => {}, failed)
  channel.expectPid(123)
  const socket = await peer(channel)
  const wake = vi.fn(); channel.setDispatcher(wake)
  const serverSocket = (channel as unknown as { socket: Socket }).socket
  vi.spyOn(serverSocket, 'write').mockImplementation(() => { throw new Error('write failed') })
  try {
    const request = channel.request('s', 'test', 4, 3)
    await expect(request.promise).rejects.toThrow('Terminal dispatch failed')
    expect(wake).not.toHaveBeenCalled()
    expect(failed).toHaveBeenCalledOnce()
    expect(channel.connected).toBe(false)
  } finally { socket.destroy(); await channel.close() }
})

it('does not wake if the channel closes while the frame write is initiated', async () => {
  const channel = await TerminalChannel.create(() => {}, () => {})
  channel.expectPid(123)
  const socket = await peer(channel)
  const wake = vi.fn(); channel.setDispatcher(wake)
  const serverSocket = (channel as unknown as { socket: Socket }).socket
  vi.spyOn(serverSocket, 'write').mockImplementation(() => { void channel.close(); return true })
  try {
    const request = channel.request('s', 'test', 4, 3)
    await expect(request.promise).rejects.toThrow('closed')
    expect(wake).not.toHaveBeenCalled()
  } finally { socket.destroy(); await channel.close() }
})

it('dispatches a maximum-sized request once without waiting for its write callback', async () => {
  const channel = await TerminalChannel.create(() => {}, () => {})
  channel.expectPid(123)
  const socket = await peer(channel)
  const wake = vi.fn(); channel.setDispatcher(wake)
  const writes = deferChannelWrites(channel)
  try {
    const request = channel.request('s', 'x'.repeat(4096), 4096, 8)
    expect(writes.frames[0]).toHaveLength('1:s:4096:8:'.length + 8192 + 1)
    expect(wake).toHaveBeenCalledExactlyOnceWith(8)
    socket.write('1;loaded;8\n')
    await expect(request.promise).resolves.toEqual({ generation: 8 })
    writes.callbacks[0]()
    expect(wake).toHaveBeenCalledOnce()
  } finally { socket.destroy(); await channel.close() }
})

it('rejects unauthenticated peers and fails malformed authenticated frames', async () => {
  const failed = vi.fn()
  const channel = await TerminalChannel.create(() => {}, failed); channel.expectPid(123)
  const bad = connect(channel.path); await once(bad, 'connect')
  bad.write('0;hello;1;wrong;123\n'); await once(bad, 'close')
  expect(failed).not.toHaveBeenCalled()
  const socket = await peer(channel)
  socket.write('0;init;start;fixed;1;ff\n')
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(failed).toHaveBeenCalledOnce()
  socket.destroy(); await channel.close()
})

it('rejects more than 64 completion options and duplicate truncation frames', async () => {
  for (const overflow of ['options', 'duplicate']) {
    const failed = vi.fn()
    const channel = await TerminalChannel.create(() => {}, failed); channel.expectPid(123)
    const socket = await peer(channel)
    const request = channel.request('c', '', 0, 1)
    const rejection = expect(request.promise).rejects.toThrow()
    if (overflow === 'options') {
      socket.write('1;result;0;\n' + Array.from({ length: 65 }, (_, i) => `1;option;${i + 1};0;\n`).join(''))
    } else {
      socket.write('1;result;0;\n1;truncated;1\n1;truncated;1\n')
    }
    await rejection
    expect(failed).toHaveBeenCalledOnce()
    socket.destroy(); await channel.close()
  }
})

it('fails an oversized frame and rejects outstanding work on channel close', async () => {
  const failed = vi.fn()
  const channel = await TerminalChannel.create(() => {}, failed); channel.expectPid(123)
  const socket = await peer(channel)
  const pending = channel.request('c', '', 0, 1)
  const rejection = expect(pending.promise).rejects.toThrow()
  socket.write('x'.repeat(16385))
  await rejection
  expect(failed).toHaveBeenCalledOnce()
  socket.destroy(); await channel.close()
})
