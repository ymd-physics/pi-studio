import { constants, createReadStream, createWriteStream } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32 } from 'node:zlib'
import * as yazl from 'yazl'
import * as yauzl from 'yauzl'

const maxEntries = 10000, maxBytes = 1024 ** 3
const limit = () => new Error('ZIP limited to 10,000 entries and 1 GiB of uncompressed data')
function safeName(path: string) {
  const parts = path.replace(/\/$/, '').split('/')
  if (parts.length > 64 || parts.some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p)))
    throw new Error('Unsupported ZIP entry name')
}
async function sibling(parent: string, stem: string, ext: string, create: (path: string) => Promise<unknown>) {
  for (let i = 1; ; i++) {
    const path = join(parent, `${stem}${i === 1 ? '' : ` (${i})`}${ext}`)
    try { await create(path); return path } catch (e: any) { if (e.code !== 'EEXIST') throw e }
  }
}
export async function compressZip(source: string) {
  const parent = dirname(source), entries: { path: string; name: string; stat: Awaited<ReturnType<typeof lstat>> }[] = []
  let bytes = 0
  async function walk(path: string) {
    const stat = await lstat(path), name = relative(parent, path).split(sep).join('/')
    safeName(name)
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('ZIP supports regular files and folders only')
    entries.push({ path, name, stat })
    if (stat.isFile()) bytes += stat.size
    if (entries.length > maxEntries || bytes > maxBytes) throw limit()
    if (stat.isDirectory()) for (const child of await readdir(path)) await walk(join(path, child))
  }
  await walk(source)
  const temp = await mkdtemp(join(parent, '.pi-zip-')), archive = join(temp, 'archive')
  try {
    const zip = new yazl.ZipFile(), stream = zip.outputStream as Readable
    zip.on('error', err => stream.destroy(err))
    for (const { path, name, stat } of entries) {
      const options = { mtime: stat.mtime, mode: Number(stat.mode) }
      if (stat.isDirectory()) zip.addEmptyDirectory(name, options)
      else zip.addReadStreamLazy(name, { ...options, size: Number(stat.size) }, cb => {
        const input = createReadStream(path, { flags: (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) as unknown as string })
        input.on('error', err => stream.destroy(err)); cb(null, input)
      })
    }
    const writing = pipeline(stream, createWriteStream(archive, { flags: 'wx', mode: 0o600 }))
    zip.end(); await writing
    await sibling(parent, basename(source), '.zip', dest => link(archive, dest))
  } finally { await rm(temp, { recursive: true, force: true }) }
}
export async function extractZip(source: string) {
  if (!/\.zip$/i.test(source) || !(await lstat(source)).isFile()) throw new Error('Choose a ZIP file')
  const zip = await yauzl.openPromise(source, { lazyEntries: true, autoClose: false, strictFileNames: true })
  let dest: string | undefined
  try {
    if (zip.entryCount > maxEntries) throw limit()
    const stem = basename(source).slice(0, -4)
    dest = await sibling(dirname(source), !stem || /^\.+$/.test(stem) ? 'Archive' : stem, '', path => mkdir(path, { mode: 0o700 }))
    let bytes = 0, count = 0
    for await (const e of zip.eachEntry()) {
      safeName(e.fileName)
      const kind = (e.externalFileAttributes >>> 16) & 0o170000
      if (e.isEncrypted() || (kind && kind !== 0o100000 && kind !== 0o040000)) throw new Error('Encrypted ZIPs and special entries are not supported')
      bytes += e.uncompressedSize
      if (++count > maxEntries || bytes > maxBytes) throw limit()
      const path = join(dest, e.fileName)
      if (e.fileName.endsWith('/') || kind === 0o040000) {
        if (e.uncompressedSize) throw new Error('Invalid ZIP directory')
        await mkdir(path, { recursive: true }); continue
      }
      await mkdir(dirname(path), { recursive: true })
      let crc = 0
      await pipeline(await zip.openReadStreamPromise(e), new Transform({ transform(chunk, _enc, cb) { crc = crc32(chunk, crc); cb(null, chunk) } }), createWriteStream(path, { flags: 'wx', mode: 0o600 | ((e.externalFileAttributes >>> 16) & 0o100) }))
      if (crc !== e.crc32) throw new Error('ZIP checksum mismatch')
    }
  } catch (err) { if (dest) await rm(dest, { recursive: true, force: true }); throw err }
  finally { zip.close() }
}
