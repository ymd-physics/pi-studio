import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { TerminalService } from './terminal-service'

// Real local PTY + actual zsh, never the operator's configuration or history.
it.each([false, true])('native fixed-editor transport with menu-select=%s', async (menuSelect) => {
  const home = await mkdtemp(join(tmpdir(), 'terminal-integration-'))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'space file.txt'), '')
  await mkdir(join(workspace, 'space folder'))
  await writeFile(join(home, '.zshrc'), `
PROMPT='fixture> '
HISTFILE=$HOME/history
setopt interactivecomments
autoload -Uz compinit
compinit -i -D
${menuSelect ? "zstyle ':completion:*' menu select" : ''}
_proofargs() { compadd alpha alpine beta; }
proofcmd() { print -r -- "$*"; }
compdef _proofargs proofcmd
`)
  const records: any[] = []
  let output = '', service: TerminalService
  service = new TerminalService((record) => {
    records.push(record)
    if (record.type === 'desktop_terminal_output') {
      output += record.data
      queueMicrotask(() => { try { service.acknowledge(record.id, record.sequence) } catch {} })
    }
  }, () => [{ path: workspace, name: 'Fixture' }], {
    HOME: home, ZDOTDIR: home, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8',
    TERMINAL_INHERITED_FIXTURE: 'inherited-value',
  }, 'test', resolve('resources/terminal/zsh-integration.zsh'))
  try {
    const { id } = await service.create(workspace)
    service.attach(id)
    const ready = () => vi.waitFor(() => expect(service.list()[0]).toMatchObject({ state: 'ready', mode: 'command' }), { timeout: 5000 })
    await ready()
    expect(service.list()[0].reason).toBeUndefined()
    const start = output.length
    for (let i = 0; i < 3; i++) {
      const files = await service.complete(id, 'cat space', 9)
      expect(files.options.map((option) => option.buffer)).toEqual(expect.arrayContaining(['cat space\\ file.txt ', 'cat space\\ folder/']))
      const custom = await service.complete(id, 'proofcmd al', 11)
      expect(custom.options.map((option) => option.buffer)).toEqual(['proofcmd alpha ', 'proofcmd alpine '])
    }
    expect(output.slice(start)).not.toContain('proofcmd al')
    const middle = await service.complete(id, 'cat space END', 9)
    expect(middle.options.every((option) => option.buffer.endsWith('END'))).toBe(true)
    await service.submit(id, "printf '%s' \"$TERMINAL_INHERITED_FIXTURE\" > inherited")
    await ready()
    expect(await readFile(join(workspace, 'inherited'), 'utf8')).toBe('inherited-value')
    // Exactly one wake must carry a full frame larger than Darwin's socket send buffer.
    await service.submit(id, '#'.padEnd(4096, 'x'))
    await ready()
    await service.setMode(id, 'direct')
    await service.interrupt(id) // Immediately after d ACK; no timer or extra wake key.
    await ready()
    await service.submit(id, "read -rs 'answer?Secret: '; printf '%s' \"$answer\" > reply")
    await vi.waitFor(() => expect(output).toContain('Secret:'), { timeout: 5000 })
    expect(service.list()[0]).toMatchObject({ mode: 'direct', state: 'running' })
    await expect(service.complete(id, 'proofcmd al', 11)).rejects.toThrow()
    service.write(id, 'private-fixture-input\r')
    await ready()
    expect(await readFile(join(workspace, 'reply'), 'utf8')).toBe('private-fixture-input')
    expect(JSON.stringify(records.filter((record) => record.type !== 'desktop_terminal_output'))).not.toContain('private-fixture-input')
    await service.submit(id, "printf '\n'")
    await ready()
    expect(records.filter((record) => record.type === 'desktop_terminal_error')).toEqual([])
    await service.close(id)
    expect(service.list()).toEqual([])
  } finally { await service.shutdown(); await rm(home, { recursive: true, force: true }) }
}, 15000)
