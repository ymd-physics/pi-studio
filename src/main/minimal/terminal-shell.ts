import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir, userInfo } from 'node:os'

const INTERNAL_ENVIRONMENT = new Set([
  'NODE_OPTIONS', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID',
  'PWD', 'OLDPWD', 'SHLVL', '_', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID',
  'ITERM_SESSION_ID', 'LC_TERMINAL', 'LC_TERMINAL_VERSION',
  'PI_DESKTOP_DATA_DIR', 'PI_DESKTOP_NODE', 'PI_DESKTOP_CLI',
])

/** Preserve user exports (including SSH/proxy/model variables), but not Electron's
 * process-control environment or another terminal's stale identity. Never log it. */
export function terminalEnvironment(
  source: NodeJS.ProcessEnv,
  identity: { id: string; version: string },
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || INTERNAL_ENVIRONMENT.has(key) || key.startsWith('ELECTRON_') || key.startsWith('PI_DESKTOP_TERMINAL_')) continue
    env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'PiDesktop'
  env.TERM_PROGRAM_VERSION = identity.version
  env.TERM_SESSION_ID = identity.id
  if (!env.LANG) env.LANG = 'en_US.UTF-8'
  return env
}

// Chain the actual user startup files once, without editing any of them. Restore
// the user's ZDOTDIR (including the distinction between unset and HOME) while
// their code executes; keep the wrapper only between startup stages.
const restoreUserDirectory = `
if (( _pi_terminal_has_zdotdir )); then
  ZDOTDIR=$_pi_terminal_user_zdotdir
else
  unset ZDOTDIR
fi
`
const sourceStage = (stage: string) => `${restoreUserDirectory}
if [[ -f \\"\${ZDOTDIR:-$HOME}/${stage}\\" ]]; then
  source \\"\${ZDOTDIR:-$HOME}/${stage}\\"
fi
_pi_terminal_has_zdotdir=\${+ZDOTDIR}
_pi_terminal_user_zdotdir=\${ZDOTDIR:-$HOME}
`.replaceAll('\\"', '"')
const installIntegration = `${restoreUserDirectory}
if [[ -r "$PI_DESKTOP_TERMINAL_INTEGRATION" ]]; then
  source "$PI_DESKTOP_TERMINAL_INTEGRATION"
fi
`

export interface PreparedTerminalShell {
  file: string
  args: string[]
  env: Record<string, string>
  integrated: boolean
  directory?: string
  cleanup(): Promise<void>
}

export async function prepareTerminalShell(options: {
  environment: NodeJS.ProcessEnv
  id: string
  version: string
  integrationPath: string
  integrationEnvironment?: Record<string, string>
  shell?: string
  temporaryRoot?: string
}): Promise<PreparedTerminalShell> {
  const file = options.shell || options.environment.SHELL || userInfo().shell || '/bin/zsh'
  if (!file.startsWith('/')) throw new Error('The login shell must be an absolute executable path')
  await access(file, constants.X_OK)
  const env = terminalEnvironment(options.environment, options)
  env.SHELL = file
  const args = ['-l', '-i']
  if (basename(file) !== 'zsh') return { file, args, env, integrated: false, cleanup: async () => {} }

  const base = options.temporaryRoot || tmpdir()
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, 'pi-terminal-shell-'))
  await chmod(directory, 0o700)
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    await rm(directory, { recursive: true, force: true })
    cleaned = true
  }
  try {
    Object.assign(env, options.integrationEnvironment)
    env.PI_DESKTOP_TERMINAL_INTEGRATION = options.integrationPath
    env.PI_DESKTOP_TERMINAL_USER_ZDOTDIR = options.environment.ZDOTDIR || env.HOME || userInfo().homedir
    env.PI_DESKTOP_TERMINAL_HAS_ZDOTDIR = Object.hasOwn(options.environment, 'ZDOTDIR') ? '1' : '0'
    env.ZDOTDIR = directory
    const start = `typeset -g _pi_terminal_wrapper=$ZDOTDIR
 typeset -g _pi_terminal_user_zdotdir=$PI_DESKTOP_TERMINAL_USER_ZDOTDIR
 typeset -gi _pi_terminal_has_zdotdir=$PI_DESKTOP_TERMINAL_HAS_ZDOTDIR
`
    const stages = {
      '.zshenv': start + sourceStage('.zshenv') + '\nZDOTDIR=$_pi_terminal_wrapper\n',
      '.zprofile': sourceStage('.zprofile') + '\nZDOTDIR=$_pi_terminal_wrapper\n',
      '.zshrc': sourceStage('.zshrc') + `
if [[ -o login ]]; then
  ZDOTDIR=$_pi_terminal_wrapper
else
${installIntegration}
fi
`,
      '.zlogin': sourceStage('.zlogin') + installIntegration,
    }
    await Promise.all(Object.entries(stages).map(([name, content]) => writeFile(join(directory, name), content, { mode: 0o600 })))
    return { file, args, env, integrated: true, directory, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
