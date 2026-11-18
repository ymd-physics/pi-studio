import { clipboard } from 'electron'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function copyFilePaths(paths: string[]) {
  const xml = paths
    .map(
      (path) =>
        `<string>${path.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</string>`,
    )
    .join('')
  clipboard.clear()
  clipboard.writeBuffer(
    'NSFilenamesPboardType',
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>${xml}</array></plist>`),
  )
}
/** Read file metadata only on an explicit paste. Never interpret ordinary clipboard text as a path. */
export async function pastedFilePaths(): Promise<string[]> {
  // Electron normalizes native macOS types to text/uri-list in availableFormats().
  // The original pasteboard buffers remain readable under their native names.
  const data = clipboard.readBuffer('NSFilenamesPboardType')
  if (data.length) {
    if (data.length > 1024 * 1024) throw new Error('Clipboard file list is too large')
    const text = await new Promise<string>((resolve, reject) => {
      const child = spawn('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { stdio: 'pipe' })
      let output = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('Clipboard file decoding timed out'))
      }, 3000)
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (output.length > 1024 * 1024) child.kill()
      })
      child.stderr.resume()
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.stdin.on('error', () => {})
      child.on('close', (code) => {
        clearTimeout(timer)
        code === 0 ? resolve(output) : reject(new Error('Invalid clipboard file list'))
      })
      child.stdin.end(data)
    })
    const paths = JSON.parse(text)
    if (
      !Array.isArray(paths) ||
      paths.length > 100 ||
      paths.some((p) => typeof p !== 'string' || !p.startsWith('/'))
    )
      throw new Error('Invalid clipboard file paths')
    return paths
  }
  const url = clipboard.readBuffer('public.file-url')
  if (url.length) {
    const value = url.toString('utf8').replace(/\0+$/, '').trim()
    return [fileURLToPath(value)]
  }
  return []
}
