import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { linkKind } from '../../../packages/shared/links'
import { resolveLocalLink, readLocalImage } from './local-links'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-links-')))
  roots.push(root)
  const workspace = join(root, 'work')
  await mkdir(join(workspace, 'plots'), { recursive: true })
  return { root, workspace }
}
it.each(['javascript:alert(1)', 'data:image/png;base64,AA', 'vbscript:x', '//host/image.png', 'file://host/a', 'https://', ' https://a', 'a\0b', '\\server\\file'])('rejects unsafe or ambiguous destinations: %s', value => {
  expect(linkKind(value)).toBeUndefined()
})
it('resolves URLs once, preserving encoded spaces, Unicode, hash and percent in file names', async () => {
  const { workspace } = await fixture()
  const path = join(workspace, 'plots', '图 # 100%.png')
  await writeFile(path, 'file')
  for (const href of [pathToFileURL(path).href, 'plots/' + encodeURIComponent('图 # 100%.png') + '#L20']) {
    expect(await resolveLocalLink(workspace, href)).toMatchObject({ path, insideWorkspace: true })
  }
  expect((await resolveLocalLink(workspace, encodeURIComponent('图 # 100%.png'), 'plots')).path).toBe(path)
  await expect(resolveLocalLink(workspace, '%zz')).rejects.toThrow('Invalid')
  await expect(resolveLocalLink(workspace, 'a%00b')).rejects.toThrow('Invalid')
})
it('classifies traversal and symlink destinations outside the workspace; rejects outside document origins', async () => {
  const { root, workspace } = await fixture()
  const outside = join(root, 'outside.png')
  await writeFile(outside, 'file')
  await symlink(outside, join(workspace, 'link.png'))
  for (const href of ['../outside.png', outside, 'link.png']) {
    expect(await resolveLocalLink(workspace, href)).toMatchObject({ path: outside, insideWorkspace: false })
  }
  await expect(resolveLocalLink(workspace, 'outside.png', '..')).rejects.toThrow('Document directory')
})
it('bounds file bytes/pixels before decoding and rejects active content and path replacement', async () => {
  const { workspace } = await fixture()
  const path = join(workspace, 'image.png')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=', 'base64')
  await writeFile(path, png)
  const target = await resolveLocalLink(workspace, 'image.png')
  expect(await readLocalImage(target)).toEqual(png)
  const huge = Buffer.from(png)
  huge.writeUInt32BE(20000, 16)
  await writeFile(path, huge)
  await expect(readLocalImage(target)).rejects.toThrow('megapixel')
  await writeFile(path, '<svg><script>alert(1)</script></svg>')
  await expect(readLocalImage(target)).rejects.toThrow('supports PNG')
  await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1))
  await expect(readLocalImage(target)).rejects.toThrow('8 MiB')
  await rm(path)
  await mkdir(path)
  await expect(readLocalImage(target)).rejects.toThrow('regular file')
})
