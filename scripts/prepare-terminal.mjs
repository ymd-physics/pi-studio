// node-pty's distributed macOS spawn-helper can arrive without its executable
// bit (notably when dependency lifecycle scripts are disabled). Fix only these
// known helpers at build/dev time; never mutate an installed application at runtime.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { chmod, lstat } from 'node:fs/promises'

const require = createRequire(import.meta.url)
const root = dirname(require.resolve('node-pty/package.json'))
for (const relative of ['prebuilds/darwin-arm64/spawn-helper', 'prebuilds/darwin-x64/spawn-helper', 'build/Release/spawn-helper', 'build/Debug/spawn-helper']) {
  const path = join(root, relative)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular node-pty helper: ${path}`)
    if ((info.mode & 0o111) !== 0o111) await chmod(path, 0o755)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
