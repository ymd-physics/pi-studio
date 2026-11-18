import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkRelease, saveDmg } from './updates'

const name = 'Pi-Studio-1.0.10-mac-arm64.dmg'
const url = `https://github.com/ymd-physics/pi-studio/releases/download/v1.0.10/${name}`
const digest = `sha256:${createHash('sha256').update('abc').digest('hex')}`
const asset = { name, browser_download_url: url, state: 'uploaded', size: 3, digest }
const release = { tag_name: 'v1.0.10', draft: false, prerelease: false, body: '中文\nEnglish', assets: [asset] }
const lookup = (r = release, version = '1.0.3', arch = 'arm64') => checkRelease(version, 'darwin', arch, async () => Response.json(r))
it('compares numeric versions, preserves both languages and matches only verified compatible assets', async () => {
  expect((await lookup()).info).toEqual({ status: 'available', version: '1.0.10', notes: release.body, dmg: true })
  for (const version of ['1.0.10', '1.1.0']) expect((await lookup(release, version)).info.status).toBe('current')
  expect((await lookup(release, '1.0.3', 'x64')).asset).toBeUndefined()
  for (const bad of [{ ...asset, digest: '' }, { ...asset, browser_download_url: 'https://example.org/other.dmg' }]) expect((await lookup({ ...release, assets: [bad] })).asset).toBeUndefined()
  await expect(lookup({ ...release, prerelease: true })).rejects.toThrow()
  await expect(checkRelease('1.0.3', 'darwin', 'arm64', async () => new Response(null, { status: 403 }))).rejects.toThrow()
})
it('only replaces a selected file after size and digest verification; cleans partial files on error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-update-'))
  try {
    const path = join(dir, name), offered = (await lookup()).asset!
    await writeFile(path, 'keep')
    for (const bytes of ['a', 'bad', 'abcd']) {
      await expect(saveDmg(offered, path, async () => new Response(bytes))).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe('keep'); expect(await readdir(dir)).toEqual([name])
    }
    await saveDmg(offered, path, async () => new Response('abc'))
    expect(await readFile(path, 'utf8')).toBe('abc')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
