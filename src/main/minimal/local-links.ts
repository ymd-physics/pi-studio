import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageSize } from 'image-size'
import { linkKind } from '../../../packages/shared/links'
import { imageMime } from './workspace-assets'

const MAX_BYTES = 8 * 1024 * 1024
export const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
}
export interface LocalTarget { path: string; root: string; insideWorkspace: boolean }

/** Resolve relative URLs against their originating workspace or Markdown directory. */
export async function resolveLocalLink(workspace: string, href: string, baseDir = ''): Promise<LocalTarget> {
  if (linkKind(href) !== 'local') throw new Error('Unsupported local link')
  if (typeof baseDir !== 'string' || baseDir.includes('\0')) throw new Error('Invalid document directory')
  const root = await realpath(workspace)
  const base = await realpath(resolve(root, baseDir))
  if (!inside(root, base)) throw new Error('Document directory must stay inside the workspace')
  let path: string
  try {
    path = /^file:/i.test(href) ? fileURLToPath(new URL(href)) : decodeURIComponent(href.split(/[?#]/, 1)[0])
  } catch { throw new Error('Invalid local file URL') }
  if (!path || /[\x00-\x1f\x7f\\]/.test(path) || path.startsWith('//')) throw new Error('Invalid local file path')
  if (path.startsWith('~/')) path = resolve(homedir(), path.slice(2))
  path = await realpath(resolve(base, path))
  const metadata = await stat(path)
  if (!metadata.isFile() && !metadata.isDirectory()) throw new Error('Link is not a regular file or folder')
  return { path, root, insideWorkspace: inside(root, path) }
}

/** Bounded raster input only. Validate dimensions BEFORE invoking an image decoder. */
export async function readLocalImage(target: LocalTarget): Promise<Buffer> {
  const file = await open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > MAX_BYTES) throw new Error('Image preview requires a regular file up to 8 MiB')
    const canonical = await realpath(target.path)
    const current = await stat(canonical)
    if (canonical !== target.path || current.dev !== metadata.dev || current.ino !== metadata.ino ||
        (target.insideWorkspace && !inside(target.root, canonical))) throw new Error('Image path changed; try again')
    const bytes = Buffer.alloc(metadata.size + 1)
    let size = 0
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, null)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    if (size !== metadata.size) throw new Error('Image changed while reading; try again')
    const data = bytes.subarray(0, size)
    if (!imageMime(data)) throw new Error('Preview supports PNG, JPEG, GIF and WebP; open the original for other formats')
    let dimensions
    try { dimensions = imageSize(data) } catch { throw new Error('Invalid or unsupported image') }
    if (!dimensions.width || !dimensions.height || dimensions.width > 16384 || dimensions.height > 16384 ||
        dimensions.width * dimensions.height > 16_000_000) throw new Error('Image exceeds the 16 megapixel preview limit')
    return data
  } finally { await file.close() }
}
