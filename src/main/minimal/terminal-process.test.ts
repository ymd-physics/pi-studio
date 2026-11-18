import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { TerminalProcess, terminalProcessSnapshot } from './terminal-process'

it('validates dimensions and reports an unsuccessful native exec via exit', async () => {
  let resolveExit!: (event: { exitCode: number }) => void
  const exit = new Promise<{ exitCode: number }>(resolve => { resolveExit = resolve })
  const options = { file: '/definitely/missing/shell', args: [], cwd: tmpdir(), env: {}, cols: 80, rows: 24, onData() {}, onExit: resolveExit }
  expect(() => new TerminalProcess({ ...options, cols: 0 })).toThrow(RangeError)
  const terminal = new TerminalProcess(options)
  expect((await exit).exitCode).not.toBe(0)
  // A failed exec may exit before ps can observe its PID; do not invent ownership.
  await terminal.close().catch((error) => expect(error.message).toContain('ownership unavailable'))
})

it('retries initial inspection within the original spawn interval before signalling any PID', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pty-inspection-'))
  let terminal: TerminalProcess | undefined
  let inspections = 0
  const kill = vi.spyOn(process, 'kill')
  try {
    terminal = new TerminalProcess({
      file: '/bin/zsh', args: ['-f', '-i'], cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }, cols: 80, rows: 24,
      onData() {}, onExit() {}, inspect: async () => {
        if (++inspections <= 2) throw new Error('inspection failed')
        return terminalProcessSnapshot()
      },
    })
    await expect(terminal.close()).rejects.toThrow('inspection failed')
    expect(kill).not.toHaveBeenCalled()
    await expect(terminal.close()).resolves.toBeUndefined()
    expect(inspections).toBe(3)
    expect(kill.mock.calls.every(([pid]) => pid === terminal!.pid)).toBe(true)
  } finally { kill.mockRestore(); await terminal?.close(); await rm(home, { recursive: true, force: true }) }
})
it.each(['rejected', 'empty'])('keeps cleanup unresolved for %s initial inspection and an exited shell with an unknown child', async (inspection) => {
  const home = await mkdtemp(join(tmpdir(), 'pty-unverified-'))
  let terminal: TerminalProcess | undefined, output = '', exited = false, child = 0
  const kill = vi.spyOn(process, 'kill')
  try {
    terminal = new TerminalProcess({
      file: '/bin/sh', args: ['-c', "(trap '' HUP; exec sleep 60) & echo CHILD:$!; sleep 0.2; exit"], cwd: home,
      env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }, cols: 80, rows: 24,
      onData(data) { output += data }, onExit() { exited = true }, inspect: async () => {
        if (inspection === 'rejected') throw new Error('inspection failed')
        return []
      },
    })
    await vi.waitFor(() => expect(exited).toBe(true), { timeout: 3000 })
    child = Number(output.match(/CHILD:(\d+)/)?.[1])
    expect(child).toBeGreaterThan(0)
    await expect(terminal.close()).rejects.toThrow('ownership unavailable')
    await expect(terminal.close()).rejects.toThrow('ownership unavailable')
    expect(kill).not.toHaveBeenCalled()
  } finally {
    kill.mockRestore()
    if (child) { try { process.kill(child, 'SIGKILL') } catch {} }
    await rm(home, { recursive: true, force: true })
  }
}, 5000)
it('bounds input and closes a controlled zsh and its foreground and background children', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pty-core-'))
  let terminal: TerminalProcess | undefined
  try {
    let output = ''
    terminal = new TerminalProcess({
      file: '/bin/zsh', args: ['-f'], cwd: home,
      env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }, cols: 80, rows: 24,
      onData(data) { output += data }, onExit() {},
    })
    expect(() => terminal!.write('a'.repeat(65537))).toThrow(RangeError)
    expect(() => terminal!.resize(1, 1001)).toThrow(RangeError)
    terminal.resize(90, 30)
    terminal.write('sleep 60 & echo BACK:$!; sleep 60\n')
    const deadline = Date.now() + 3000
    let back = 0, fore = 0
    while (Date.now() < deadline) {
      back = Number(output.match(/BACK:(\d+)/)?.[1])
      const lines = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n')
      fore = Number(lines.map(line => line.trim().match(/^(\d+)\s+(\d+)\s+.*sleep$/)).find(match => match && Number(match[2]) === terminal!.pid && Number(match[1]) !== back)?.[1])
      if (back && fore) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(back).toBeGreaterThan(0); expect(fore).toBeGreaterThan(0)
    const first = terminal.close()
    expect(terminal.close()).toBe(first)
    await first
    for (const pid of [terminal.pid, back, fore]) expect(() => process.kill(pid, 0)).toThrow()
    expect(() => terminal!.write('x')).toThrow('closed')
  } finally {
    await terminal?.close()
    await rm(home, { recursive: true, force: true })
  }
}, 10000)

it('cleans a HUP-ignoring same-session child after its shell exits', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pty-reparent-'))
  let terminal: TerminalProcess | undefined, child = 0
  try {
    let output = ''
    terminal = new TerminalProcess({
      file: '/bin/sh', args: ['-c', "(trap '' HUP; exec sleep 60) & echo CHILD:$!; sleep 0.3; exit"], cwd: home,
      env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }, cols: 80, rows: 24,
      onData(data) { output += data }, onExit() {},
    })
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      child = Number(output.match(/CHILD:(\d+)/)?.[1]) || 0
      if (child) {
        const ppid = execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(child)], { encoding: 'utf8' }).trim()
        if (Number(ppid) !== terminal.pid) break
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(child).toBeGreaterThan(0)
    expect(Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(child)], { encoding: 'utf8' }).trim())).not.toBe(terminal.pid)
    await terminal.close()
    expect(() => process.kill(child, 0)).toThrow()
    child = 0
  } finally {
    if (child) { try { process.kill(child, 'SIGKILL') } catch {} }
    await terminal?.close()
    await rm(home, { recursive: true, force: true })
  }
}, 10000)
