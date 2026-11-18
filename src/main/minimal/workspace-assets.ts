import { constants } from 'node:fs'
import { lstat, realpath, mkdir, open, unlink, link, rename, readdir, copyFile, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, isAbsolute } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { Attachment, AttachmentInput, FileOperation } from '../../../packages/shared/assets'

const LIMIT = 32 * 1024 * 1024
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
export function imageMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a/.test(data.toString('ascii', 0, 6))) return 'image/gif'
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
}
function name(value: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value === '.' ||
    value === '..' ||
    /[/\\\x00-\x1f:]/.test(value) ||
    Buffer.byteLength(value) > 200
  )
    throw new Error('Use a file name without slashes or control characters (up to 200 bytes)')
  return value
}
/** Reject symlinks in every component, including the final entry for destructive operations. */
export async function assetPath(workspace: string, path: string, missingLeaf = false): Promise<string> {
  if (
    typeof path !== 'string' ||
    isAbsolute(path) ||
    path.includes('\0') ||
    path.split('/').some((p) => p === '..')
  )
    throw new Error('Path must stay inside the workspace')
  const root = await realpath(workspace)
  let target = root
  const parts = path.split('/').filter((part) => part && part !== '.')
  for (let i = 0; i < parts.length; i++) {
    target = join(target, parts[i])
    const metadata = await lstat(target).catch((e) => {
      if (missingLeaf && i === parts.length - 1 && e.code === 'ENOENT') return undefined
      throw e
    })
    if (metadata?.isSymbolicLink())
      throw Object.assign(new Error('File management does not follow symbolic links'), {
        code: 'UNSAFE_ASSET_PATH',
      })
    if (i < parts.length - 1 && !metadata?.isDirectory()) throw new Error('Parent is not a folder')
  }
  return target
}
async function readBounded(path: string) {
  const validate = (metadata: { isFile(): boolean; size: number }) => {
    if (!metadata.isFile() || metadata.size > LIMIT)
      throw Object.assign(new Error('Choose a regular file no larger than 32 MiB'), {
        code: 'ATTACHMENT_CHANGED',
      })
  }
  validate(await lstat(path))
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const metadata = await file.stat()
    validate(metadata)
    const data = Buffer.alloc(metadata.size + 1)
    let size = 0
    while (size < data.length) {
      const result = await file.read(data, size, data.length - size, null)
      if (!result.bytesRead) break
      size += result.bytesRead
    }
    if (size > metadata.size)
      throw Object.assign(new Error('File changed while being read; try again'), {
        code: 'ATTACHMENT_CHANGED',
      })
    return data.subarray(0, size)
  } finally {
    await file.close()
  }
}
type Owned = { workspace: string; owner: string; attachment: Attachment; digest: string; sent: boolean }
export class WorkspaceAssets {
  private owned = new Map<string, Owned>()
  private queue: Promise<unknown> = Promise.resolve()
  private serial<T>(fn: () => Promise<T>) {
    const next = this.queue.then(fn)
    this.queue = next.catch(() => {})
    return next
  }
  async import(workspace: string, owner: string, inputs: AttachmentInput[]): Promise<Attachment[]> {
    return this.serial(async () => {
      if (
        !Array.isArray(inputs) ||
        !inputs.length ||
        inputs.length + [...this.owned.values()].filter((a) => a.owner === owner && !a.sent).length > 10
      )
        throw new Error('Up to 10 pending attachments per session')
      for (const part of ['.pi', '.pi/attachments']) {
        const path = await assetPath(workspace, part, true)
        await mkdir(path, { mode: 0o700 }).catch((e) => {
          if (e.code !== 'EEXIST') throw e
        })
        if (!(await lstat(await assetPath(workspace, part))).isDirectory())
          throw new Error('Attachment destination is not a directory')
      }
      const added: Attachment[] = []
      try {
        for (const input of inputs) {
          const data = 'path' in input ? await readBounded(input.path) : Buffer.from(input.bytes)
          if (data.length > LIMIT) throw new Error('Attachment exceeds 32 MiB')
          const original = 'path' in input ? basename(input.path) : input.name
          const safe = (original || 'pasted-image.png').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(-70)
          const id = randomUUID()
          const path = `.pi/attachments/${new Date().toISOString().replace(/[:.]/g, '-')}-${id}-${safe}`
          const absolute = await assetPath(workspace, path, true)
          const file = await open(absolute, 'wx', 0o600)
          try {
            await file.writeFile(data)
          } catch (e) {
            await unlink(absolute).catch(() => {})
            throw e
          } finally {
            await file.close()
          }
          const attachment: Attachment = {
            id,
            name: original,
            path,
            size: data.length,
            mimeType: imageMime(data),
          }
          this.owned.set(id, { workspace, owner, attachment, digest: hash(data), sent: false })
          added.push(attachment)
        }
        return added
      } catch (e) {
        for (const a of added) await this.remove(workspace, owner, a.id).catch(() => {})
        throw e
      }
    })
  }
  private get(workspace: string, owner: string, id: string) {
    const item = this.owned.get(id)
    if (!item || item.owner !== owner || item.workspace !== workspace)
      throw new Error('Attachment does not belong to this session')
    return item
  }
  async bytes(workspace: string, owner: string, id: string) {
    const item = this.get(workspace, owner, id)
    const data = await readBounded(await assetPath(workspace, item.attachment.path))
    if (hash(data) !== item.digest)
      throw Object.assign(new Error('Attachment changed on disk; remove and attach it again'), {
        code: 'ATTACHMENT_CHANGED',
      })
    return data
  }
  discard(workspace: string, owner: string, id: string) {
    return this.serial(() => this.remove(workspace, owner, id))
  }
  private async remove(workspace: string, owner: string, id: string) {
    const item = this.get(workspace, owner, id)
    if (!item.sent) {
      try {
        await this.bytes(workspace, owner, id)
        await unlink(await assetPath(workspace, item.attachment.path))
      } catch (e: any) {
        // Modified or replaced copies no longer belong to this draft. Detach them,
        // but preserve the changed disk entry rather than deleting someone else's work.
        if (!['ENOENT', 'ATTACHMENT_CHANGED', 'UNSAFE_ASSET_PATH'].includes(e.code)) throw e
      }
    }
    this.owned.delete(id)
  }
  async prepare(workspace: string, owner: string, ids: string[]) {
    if (!Array.isArray(ids) || ids.length > 10 || new Set(ids).size !== ids.length)
      throw new Error('Invalid attachments')
    const attachments = ids.map((id) => this.get(workspace, owner, id).attachment)
    const images: { type: 'image'; data: string; mimeType: string }[] = []
    let imageBytes = 0
    for (const attachment of attachments) {
      const data = await this.bytes(workspace, owner, attachment.id)
      if (attachment.mimeType) {
        imageBytes += data.length
        if (imageBytes > 16 * 1024 * 1024) throw new Error('Images in one message must total at most 16 MiB')
        images.push({ type: 'image', mimeType: attachment.mimeType, data: data.toString('base64') })
      }
    }
    return { attachments, images }
  }
  retain(workspace: string, owner: string, ids: string[]) {
    for (const id of ids) this.get(workspace, owner, id).sent = true
  }
  async cleanOwner(workspace: string, owner: string) {
    return this.serial(async () => {
      for (const [id, item] of this.owned)
        if (item.owner === owner && item.workspace === workspace)
          await this.remove(workspace, owner, id).catch(() => {})
    })
  }
  operate(workspace: string, operation: FileOperation, trash: (path: string) => Promise<void>) {
    return this.serial(async () => {
      if (operation.type === 'create') {
        const target = await assetPath(workspace, join(operation.directory, name(operation.name)), true)
        if (operation.folder) await mkdir(target)
        else {
          const file = await open(target, 'wx')
          await file.close()
        }
      } else if (operation.type === 'rename' || operation.type === 'trash') {
        const target = await assetPath(workspace, operation.path)
        if (target === (await realpath(workspace))) throw new Error('Cannot modify the workspace root')
        if (operation.type === 'trash') await trash(target)
        else {
          const dest = await assetPath(workspace, join(dirname(operation.path), name(operation.name)), true)
          if (dest === target) return
          if ((await lstat(target)).isFile()) {
            await link(target, dest)
            await unlink(target)
          } else {
            await lstat(dest).then(
              () => {
                throw new Error('Destination already exists')
              },
              (e) => {
                if (e.code !== 'ENOENT') throw e
              },
            )
            await rename(target, dest)
          }
        }
      } else if (operation.type === 'copy') {
        if (!Array.isArray(operation.paths) || !operation.paths.length || operation.paths.length > 100)
          throw new Error('Choose 1–100 files to paste')
        const directory = await assetPath(workspace, operation.directory)
        let count = 0,
          size = 0
        const copy = async (source: string, dest: string): Promise<void> => {
          const metadata = await lstat(source)
          if (++count > 2000 || metadata.isSymbolicLink())
            throw new Error('Copy limited to 2000 entries without symbolic links')
          if (metadata.isDirectory()) {
            await mkdir(dest)
            try {
              for (const child of await readdir(source)) await copy(join(source, child), join(dest, child))
            } catch (e) {
              await rm(dest, { recursive: true, force: true })
              throw e
            }
          } else if (metadata.isFile()) {
            size += metadata.size
            if (size > 128 * 1024 * 1024) throw new Error('Copy limited to 128 MiB')
            await copyFile(source, dest, constants.COPYFILE_EXCL)
          } else throw new Error('Only regular files and folders can be copied')
        }
        for (const source of operation.paths) {
          const canonical = await realpath(source)
          if ((await lstat(source)).isSymbolicLink()) throw new Error('Cannot copy a symbolic link')
          const dest = join(directory, name(basename(source)))
          const within = relative(canonical, dest)
          if (!within || (!within.startsWith('..') && !isAbsolute(within)))
            throw new Error('Cannot copy a folder into itself')
          await copy(canonical, dest)
        }
      } else throw new Error('Unknown file operation')
    })
  }
}
