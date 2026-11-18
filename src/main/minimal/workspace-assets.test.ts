import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir, truncate, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceAssets, assetPath } from './workspace-assets'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-assets-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  return { root, workspace, assets: new WorkspaceAssets() }
}
it('copies without changing originals, enforces ownership, and deletes only pending copies', async () => {
  const { root, workspace, assets } = await fixture()
  const original = join(root, '论文 notes.txt')
  await writeFile(original, 'original')
  const [a] = await assets.import(workspace, 'A', [{ path: original }])
  expect(a.path).toMatch(/^\.pi\/attachments\//)
  expect(await readFile(join(workspace, a.path), 'utf8')).toBe('original')
  await expect(assets.discard(workspace, 'B', a.id)).rejects.toThrow('belong')
  await assets.discard(workspace, 'A', a.id)
  await expect(readFile(join(workspace, a.path))).rejects.toThrow()
  expect(await readFile(original, 'utf8')).toBe('original')
  const [sent] = await assets.import(workspace, 'A', [{ path: original }])
  assets.retain(workspace, 'A', [sent.id])
  await assets.discard(workspace, 'A', sent.id)
  expect(await readFile(join(workspace, sent.path), 'utf8')).toBe('original')
})
it('refuses altered copies and symlink destinations rather than deleting someone else’s file', async () => {
  const { root, workspace, assets } = await fixture()
  const [a] = await assets.import(workspace, 'A', [{ name: 'x.txt', bytes: Buffer.from('one') }])
  await writeFile(join(workspace, a.path), 'other')
  await expect(assets.prepare(workspace, 'A', [a.id])).rejects.toThrow('changed')
  await assets.discard(workspace, 'A', a.id)
  await expect(assets.prepare(workspace, 'A', [a.id])).rejects.toThrow('belong')
  expect(await readFile(join(workspace, a.path), 'utf8')).toBe('other')
  const second = join(root, 'second')
  await mkdir(second)
  await symlink(workspace, join(second, '.pi'))
  await expect(assets.import(second, 'B', [{ name: 'x', bytes: Buffer.from('x') }])).rejects.toThrow(
    'symbolic',
  )
})
it.each(['oversized', 'directory'])('detaches %s replacements without deleting them', async (kind) => {
  const { workspace, assets } = await fixture()
  const [a] = await assets.import(workspace, 'A', [{ name: 'x', bytes: Buffer.from('small') }])
  const path = join(workspace, a.path)
  if (kind === 'oversized') await truncate(path, 33 * 1024 * 1024)
  else {
    await rm(path)
    await mkdir(path)
  }
  await assets.discard(workspace, 'A', a.id)
  expect(await stat(path)).toBeTruthy()
  await expect(assets.prepare(workspace, 'A', [a.id])).rejects.toThrow('belong')
})
it('identifies native image payloads from bytes, not filename and enforces quantity', async () => {
  const { workspace, assets } = await fixture()
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTWkAAAAASUVORK5CYII=',
    'base64',
  )
  const [a] = await assets.import(workspace, 'A', [{ name: 'misleading.txt', bytes: png }])
  expect((await assets.prepare(workspace, 'A', [a.id])).images[0]).toEqual({
    type: 'image',
    mimeType: 'image/png',
    data: png.toString('base64'),
  })
  await expect(
    assets.import(
      workspace,
      'A',
      Array.from({ length: 10 }, () => ({ name: 'x', bytes: Buffer.alloc(1) })),
    ),
  ).rejects.toThrow('10')
})
it('rejects root/traversal/symlink operations and never overwrites a file', async () => {
  const { root, workspace, assets } = await fixture()
  const trash = vi.fn()
  await writeFile(join(workspace, 'one'), '1')
  await writeFile(join(workspace, 'two'), '2')
  await expect(
    assets.operate(workspace, { type: 'rename', path: 'one', name: 'two' }, trash),
  ).rejects.toThrow()
  expect(await readFile(join(workspace, 'two'), 'utf8')).toBe('2')
  await expect(assets.operate(workspace, { type: 'trash', path: '' }, trash)).rejects.toThrow('root')
  await expect(assetPath(workspace, '../escape')).rejects.toThrow('workspace')
  await symlink(root, join(workspace, 'outside'))
  await expect(assets.operate(workspace, { type: 'trash', path: 'outside' }, trash)).rejects.toThrow(
    'symbolic',
  )
  expect(trash).not.toHaveBeenCalled()
})
it('creates, copies, renames and trashes workspace files with bounded directory copy', async () => {
  const { root, workspace, assets } = await fixture()
  const trash = vi.fn(async (path) => {
    await rm(path, { recursive: true })
  })
  await assets.operate(workspace, { type: 'create', directory: '', name: 'folder', folder: true }, trash)
  await assets.operate(
    workspace,
    { type: 'create', directory: 'folder', name: 'file.txt', folder: false },
    trash,
  )
  await assets.operate(workspace, { type: 'rename', path: 'folder/file.txt', name: 'renamed.txt' }, trash)
  const external = join(root, 'external.txt')
  await writeFile(external, 'copy')
  await assets.operate(workspace, { type: 'copy', directory: 'folder', paths: [external] }, trash)
  expect(await readFile(join(workspace, 'folder/external.txt'), 'utf8')).toBe('copy')
  await expect(
    assets.operate(
      workspace,
      { type: 'copy', directory: 'folder', paths: [join(workspace, 'folder')] },
      trash,
    ),
  ).rejects.toThrow('itself')
  await assets.operate(workspace, { type: 'trash', path: 'folder' }, trash)
  expect(await readdir(workspace)).toEqual([])
})
