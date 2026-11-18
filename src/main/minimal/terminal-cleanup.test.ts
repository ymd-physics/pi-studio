import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { TerminalChannel } from './terminal-channel'
import { prepareTerminalShell } from './terminal-shell'

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, rm: vi.fn(actual.rm) }
})

it('retries channel directory removal even after the socket has closed', async () => {
  const channel = await TerminalChannel.create(() => {}, () => {})
  try {
    vi.mocked(rm).mockRejectedValueOnce(new Error('temporary removal failure'))
    await expect(channel.close()).rejects.toThrow('temporary removal failure')
    expect(channel.connected).toBe(false)
    await channel.close()
    await expect(stat(channel.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await channel.close() }
})
it('does not mark shell wrapper cleanup complete until removal succeeds', async () => {
  const home = await mkdtemp(join(tmpdir(), 'terminal-cleanup-'))
  const shell = await prepareTerminalShell({ environment: { HOME: home, SHELL: '/bin/zsh' }, id: 'test', version: 'test', integrationPath: '' })
  try {
    vi.mocked(rm).mockRejectedValueOnce(new Error('temporary removal failure'))
    await expect(shell.cleanup()).rejects.toThrow('temporary removal failure')
    await shell.cleanup()
    await expect(stat(shell.directory!)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await shell.cleanup(); await rm(home, { recursive: true, force: true }) }
})
