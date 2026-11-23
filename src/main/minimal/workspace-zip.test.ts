import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compressZip, extractZip } from './workspace-zip'
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'studio-zip-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
it('round-trips nested Unicode names, binary data and empty directories without overwriting', async () => {
  const folder = join(root, '资料'), bytes = Buffer.from([0, 19, 255, 7])
  await mkdir(join(folder, '空'), { recursive: true }); await writeFile(join(folder, 'a b.bin'), bytes)
  await compressZip(folder); await compressZip(folder)
  await extractZip(folder + '.zip'); await extractZip(folder + '.zip')
  for (const n of [2, 3]) {
    expect(await readFile(join(`${folder} (${n})`, '资料', 'a b.bin'))).toEqual(bytes)
    expect(await readdir(join(`${folder} (${n})`, '资料', '空'))).toEqual([])
  }
  expect(await readFile(folder + ' (2).zip')).toEqual(await readFile(folder + '.zip'))
})
it('rejects links and corrupt archives without keeping partial results', async () => {
  await mkdir(join(root, 'data')); await symlink(root, join(root, 'data', 'link'))
  await expect(compressZip(join(root, 'data'))).rejects.toThrow()
  const file = join(root, 'note'); await writeFile(file, 'contents'); await compressZip(file)
  const bytes = await readFile(file + '.zip'); const central = bytes.indexOf(Buffer.from([0x50,0x4b,1,2])); bytes[central+16] ^= 1
  await writeFile(file + '.zip', bytes); await expect(extractZip(file + '.zip')).rejects.toThrow(/checksum/)
  expect((await readdir(root)).sort()).toEqual(['data','note','note.zip'])
})
