import { createHash, randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { projectUrl, type UpdateInfo } from '../../../packages/shared/updates'

const latest = 'https://api.github.com/repos/ymd-physics/pi-studio/releases/latest'
type Fetch = (url: string, init: RequestInit) => Promise<Response>
type Asset = { version: string; name: string; url: string; size: number; digest: string }
function versionParts(tag: string) {
  if (!/^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(tag)) throw new Error('Invalid stable version')
  return tag.replace(/^v/, '').split('.').map(Number)
}
export async function checkRelease(current: string, platform: string, arch: string, fetcher: Fetch): Promise<{ info: UpdateInfo; asset?: Asset }> {
  const res = await fetcher(latest, { headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error('Release lookup failed')
  const r = await res.json()
  if (r.draft !== false || r.prerelease !== false || typeof r.tag_name !== 'string' || !Array.isArray(r.assets)) throw new Error('Invalid release')
  const remote = versionParts(r.tag_name), local = versionParts(current)
  if ((remote.map((part, i) => part - local[i]).find(diff => diff !== 0) ?? 0) <= 0) return { info: { status: 'current' } }
  const version = remote.join('.')
  const name = `Pi-Studio-${version}-mac-${arch}.dmg`
  const url = `${projectUrl}/releases/download/${r.tag_name}/${name}`
  const match = platform === 'darwin' && ['arm64', 'x64'].includes(arch) && r.assets.find((a: any) => a?.name === name && a.browser_download_url === url && a.state === 'uploaded' && Number.isSafeInteger(a.size) && a.size > 0 && a.size <= 1024 ** 3 && /^sha256:[a-f0-9]{64}$/.test(a.digest))
  return { info: { status: 'available', version, notes: typeof r.body === 'string' ? r.body.slice(0, 125000) : '', dmg: !!match }, asset: match ? { name, version, url, size: match.size, digest: match.digest } : undefined }
}

// Never replace a user-selected destination with partial or unverified bytes.
export async function saveDmg(asset: Asset, path: string, fetcher: Fetch) {
  const res = await fetcher(asset.url, { credentials: 'omit', signal: AbortSignal.timeout(30 * 60 * 1000) })
  if (!res.ok || !res.body) throw new Error('Download failed')
  const tmp = join(dirname(path), `.pi-update-${randomUUID()}.part`)
  // Open before reading: an immediate size failure must not race a pending open against cleanup.
  const file = await open(tmp, 'wx', 0o600)
  try {
    const reader = res.body.getReader(), hash = createHash('sha256')
    let size = 0
    async function* chunks() {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > asset.size) throw new Error('Unexpected download size')
          hash.update(value)
          yield value
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    }
    await pipeline(chunks(), file.createWriteStream())
    if (size !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest) throw new Error('DMG verification failed')
    await rename(tmp, path)
  } finally { await file.close(); await rm(tmp, { force: true }) }
}
