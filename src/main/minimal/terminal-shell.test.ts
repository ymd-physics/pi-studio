import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prepareTerminalShell, terminalEnvironment } from './terminal-shell'

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-terminal-startup-test-'))
  roots.push(root)
  const home = join(root, "home with 'quotes")
  await mkdir(home)
  const integration = join(root, "integration's helper.zsh")
  await writeFile(integration, 'print -r -- "integration:${+ZDOTDIR}" >> "$HOME/order"\nexport INTEGRATION_DONE=yes\n')
  return { root, home, integration }
}

describe('terminal environment and isolated shell startup', () => {
  it('preserves user exports, never mutates source, and resets internal terminal identity', () => {
    const source = { HOME: '/fixture', PATH: '/custom:/bin', SHELL: '/bin/zsh', ZDOTDIR: '/custom-zsh', API_KEY: 'fixture-only', SSH_AUTH_SOCK: '/fixture/ssh', HTTPS_PROXY: 'http://fixture', NODE_OPTIONS: '--inspect', NODE_CHANNEL_FD: '3', ELECTRON_RUN_AS_NODE: '1', ELECTRON_RENDERER_URL: 'http://fixture', PI_DESKTOP_DATA_DIR: '/fixture/data', PI_CODING_AGENT_DIR: '/fixture/agent', PI_DESKTOP_TERMINAL_OLD: 'stale', TERM: 'dumb', ITERM_SESSION_ID: 'old' }
    const env = terminalEnvironment(source, { id: 'terminal-test', version: '0.9.5' })
    expect(env).toMatchObject({ HOME: source.HOME, PATH: source.PATH, ZDOTDIR: source.ZDOTDIR, API_KEY: source.API_KEY, SSH_AUTH_SOCK: source.SSH_AUTH_SOCK, HTTPS_PROXY: source.HTTPS_PROXY, PI_CODING_AGENT_DIR: source.PI_CODING_AGENT_DIR, TERM: 'xterm-256color', TERM_SESSION_ID: 'terminal-test', TERM_PROGRAM: 'PiDesktop', TERM_PROGRAM_VERSION: '0.9.5', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' })
    for (const name of ['NODE_OPTIONS', 'NODE_CHANNEL_FD', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'PI_DESKTOP_DATA_DIR', 'PI_DESKTOP_TERMINAL_OLD', 'ITERM_SESSION_ID']) expect(env).not.toHaveProperty(name)
    expect(source.TERM).toBe('dumb')
    expect(terminalEnvironment({ LANG: 'fixture-locale' }, { id: 'x', version: 'x' }).LANG).toBe('fixture-locale')
  })

  it('loads user login startup once, preserves unset ZDOTDIR, then installs integration without editing user files', async () => {
    const { root, home, integration } = await fixture()
    const files = {
      '.zshenv': 'print -r -- "env:${+ZDOTDIR}" >> "$HOME/order"\nexport PROOF_VARIABLE=user-export\n',
      '.zprofile': 'print -r -- "profile:${+ZDOTDIR}" >> "$HOME/order"\n',
      '.zshrc': 'print -r -- "rc:${+ZDOTDIR}" >> "$HOME/order"\nproof_function() { print -r -- user-function; }\n',
      '.zlogin': 'print -r -- "login:${+ZDOTDIR}" >> "$HOME/order"\n',
    }
    await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(home, name), text)))
    const prepared = await prepareTerminalShell({ environment: { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }, id: 'test', version: '0.9.5', integrationPath: integration, temporaryRoot: root })
    try {
      expect(prepared.integrated).toBe(true)
      expect((await stat(prepared.directory!)).mode & 0o777).toBe(0o700)
      expect((await stat(join(prepared.directory!, '.zshrc'))).mode & 0o777).toBe(0o600)
      const result = await exec(prepared.file, [...prepared.args, '-c', 'print -r -- "$PROOF_VARIABLE:$INTEGRATION_DONE:${ZDOTDIR-unset}"; proof_function'], { env: prepared.env, timeout: 5000 })
      expect(result.stdout).toBe('user-export:yes:unset\nuser-function\n')
      expect(await readFile(join(home, 'order'), 'utf8')).toBe('env:0\nprofile:0\nrc:0\nlogin:0\nintegration:0\n')
      for (const [name, text] of Object.entries(files)) expect(await readFile(join(home, name), 'utf8')).toBe(text)
    } finally { await prepared.cleanup() }
    await prepared.cleanup()
    await expect(stat(prepared.directory!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('honors a custom ZDOTDIR and a user .zshenv redirect for later stages', async () => {
    const { root, home, integration } = await fixture()
    const original = join(root, 'original config'), redirected = join(home, 'redirected')
    await Promise.all([mkdir(original), mkdir(redirected)])
    await writeFile(join(original, '.zshenv'), 'print -r -- "env:$ZDOTDIR" >> "$HOME/order"\nZDOTDIR=$HOME/redirected\n')
    for (const [stage, name] of [['.zprofile', 'profile'], ['.zshrc', 'rc'], ['.zlogin', 'login']]) await writeFile(join(redirected, stage), `print -r -- "${name}:$ZDOTDIR" >> "$HOME/order"\n`)
    const prepared = await prepareTerminalShell({ environment: { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', ZDOTDIR: original }, id: 'test', version: '0.9.5', integrationPath: integration, temporaryRoot: root })
    try {
      const result = await exec(prepared.file, [...prepared.args, '-c', 'print -r -- "$ZDOTDIR:$INTEGRATION_DONE"'], { env: prepared.env, timeout: 5000 })
      expect(result.stdout).toBe(`${redirected}:yes\n`)
      expect(await readFile(join(home, 'order'), 'utf8')).toBe(`env:${original}\nprofile:${redirected}\nrc:${redirected}\nlogin:${redirected}\nintegration:1\n`)
    } finally { await prepared.cleanup() }
  })

  it('installs after zshrc for a non-login interactive shell and leaves other shells unwrapped', async () => {
    const { root, home, integration } = await fixture()
    await writeFile(join(home, '.zshrc'), 'print -r -- rc >> "$HOME/order"\n')
    const options = { environment: { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }, id: 'test', version: '0.9.5', integrationPath: integration, temporaryRoot: root }
    const prepared = await prepareTerminalShell(options)
    try {
      const result = await exec(prepared.file, ['-i', '-c', 'print -r -- "$INTEGRATION_DONE:${ZDOTDIR-unset}"'], { env: prepared.env, timeout: 5000 })
      expect(result.stdout).toBe('yes:unset\n')
      expect(await readFile(join(home, 'order'), 'utf8')).toBe('rc\nintegration:0\n')
    } finally { await prepared.cleanup() }
    const other = await prepareTerminalShell({ ...options, shell: '/bin/bash' })
    expect(other).toMatchObject({ file: '/bin/bash', integrated: false })
    expect(other.env).not.toHaveProperty('ZDOTDIR')
    await other.cleanup()
    await expect(prepareTerminalShell({ ...options, shell: 'zsh' })).rejects.toThrow('absolute')
  })
})
