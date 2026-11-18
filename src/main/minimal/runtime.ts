import { access, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, delimiter, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

export interface PiInstallation {
  cli: string
  sdk: string
  version: string
  node: string
}
const scopes = ['@earendil-works', '@mariozechner']

async function executable(name: string): Promise<string> {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const path = resolve(dir, name + suffix)
      try {
        await access(path, constants.X_OK)
        return path
      } catch {
        /* next */
      }
    }
  }
  throw new Error(`${name} not found. Install Pi and Node.js, or set PI_DESKTOP_CLI and PI_DESKTOP_NODE.`)
}

async function fromRoot(root: string, node: string): Promise<PiInstallation | undefined> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    if (!scopes.some((scope) => pkg.name === `${scope}/pi-coding-agent`)) return
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi
    const entry =
      typeof pkg.exports?.['.'] === 'string' ? pkg.exports['.'] : pkg.exports?.['.']?.import || pkg.main
    if (!bin || !entry) return
    const cli = resolve(root, bin),
      sdk = resolve(root, entry)
    await Promise.all([access(cli), access(sdk)])
    return { cli, sdk, version: pkg.version, node }
  } catch {
    return
  }
}

/** Resolve the CLI and SDK from the SAME installation. Never fall back to a bundled agent. */
export async function discoverPi(): Promise<PiInstallation> {
  let node = process.env.PI_DESKTOP_NODE
  if (!node) {
    const managedNode = join(
      process.env.XDG_DATA_HOME || join(homedir(), '.local/share'),
      'pi-node/current/bin/node',
    )
    try {
      await access(managedNode, constants.X_OK)
      node = managedNode
    } catch {
      node = await executable('node')
    }
  }
  const launcher = process.env.PI_DESKTOP_CLI || (await executable('pi'))
  const actual = await realpath(launcher)
  let dir = dirname(actual)
  for (let i = 0; i < 6; i++, dir = dirname(dir)) {
    const found = await fromRoot(dir, node)
    if (found) return found
    for (const scope of scopes) {
      const beside = await fromRoot(join(dir, 'node_modules', scope, 'pi-coding-agent'), node)
      if (beside) return beside
    }
  }
  // Pi's managed installer uses a shell launcher and a current-version pointer.
  const install = join(dirname(dirname(actual)), 'install')
  try {
    const version = (await readFile(join(install, 'current-version'), 'utf8')).trim()
    if (!/^[\w.+-]+$/.test(version) || version === '..') throw new Error('Invalid version')
    for (const scope of scopes) {
      const found = await fromRoot(
        join(install, 'releases', version, 'node_modules', scope, 'pi-coding-agent'),
        node,
      )
      if (found) return found
    }
  } catch {
    /* actionable error below */
  }
  throw new Error(
    `Cannot locate the Pi SDK beside ${launcher}. Set PI_DESKTOP_CLI to the installed package's CLI .js file.`,
  )
}

export async function loadSessionManager(installation: PiInstallation) {
  const sdk = await import(/* @vite-ignore */ pathToFileURL(installation.sdk).href)
  if (!sdk.SessionManager?.list || !sdk.SessionManager?.create)
    throw new Error('This Pi installation lacks native session APIs. Update Pi in the terminal.')
  return sdk
}
