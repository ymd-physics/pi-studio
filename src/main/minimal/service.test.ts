import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopService } from './service'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-service-test-'))
  dirs.push(dir)
  const service = new DesktopService(dir, () => {})
  ;(service as any).current = { workspace: dir, state: {}, messages: [] }
  return { service, dir }
}
it('persists only supported font presets without changing unrelated preferences', async () => {
  const { service, dir } = await fixture()
  expect(service.preferences.font).toBe('default')
  await service.updatePreferences({ font: 'serif' })
  await service.updatePreferences({ font: 'untrusted-font' as any })
  const saved = JSON.parse(await readFile(join(dir, 'preferences.json'), 'utf8'))
  expect(saved.font).toBe('serif')
  expect(saved.theme).toBe('system')
  expect(saved.enterToSend).toBe(true)
  await service.updatePreferences({ font: 'default' })
  expect(JSON.parse(await readFile(join(dir, 'preferences.json'), 'utf8')).font).toBe('default')
})
it('persists a shared terminal font size and rejects invalid changes atomically', async () => {
  const { service, dir } = await fixture()
  expect(service.preferences.terminalFontSize).toBe('auto')
  await service.updatePreferences({ terminalFontSize: 17 })
  expect(JSON.parse(await readFile(join(dir, 'preferences.json'), 'utf8')).terminalFontSize).toBe(17)
  for (const value of [9, 23, 15.5, NaN, '17', null, undefined]) {
    await expect(service.updatePreferences({ terminalFontSize: value as any, theme: 'dark' })).rejects.toThrow('Terminal font size')
    expect(service.preferences.theme).toBe('system')
    expect(service.preferences.terminalFontSize).toBe(17)
  }
  await service.updatePreferences({ terminalFontSize: 'auto' })
  expect(JSON.parse(await readFile(join(dir, 'preferences.json'), 'utf8')).terminalFontSize).toBe('auto')
})
it('renames only the registered workspace display name and persists it', async () => {
  const { service, dir } = await fixture()
  await service.addWorkspace(dir)
  const path = service.preferences.workspaces[0].path
  service.preferences.activeWorkspace = path
  service.preferences.activeSession = '/session.jsonl'
  await writeFile(join(dir, 'keep.txt'), 'unchanged')
  await service.renameWorkspace(path, '  Physics  ')
  const saved = JSON.parse(await readFile(join(dir, 'preferences.json'), 'utf8'))
  expect(saved.workspaces).toEqual([{ path, name: 'Physics' }])
  expect(saved.activeWorkspace).toBe(path)
  expect(saved.activeSession).toBe('/session.jsonl')
  expect(await readFile(join(dir, 'keep.txt'), 'utf8')).toBe('unchanged')
  for (const name of ['', '  ', 'x'.repeat(81), 'bad\nname', null]) await expect(service.renameWorkspace(path, name as any)).rejects.toThrow('Workspace name')
  await expect(service.renameWorkspace('/unregistered', 'Other')).rejects.toThrow('not registered')
  expect(service.preferences.workspaces[0].name).toBe('Physics')
})

describe('file save ownership', () => {
  it('accepts exactly one concurrent save with the same revision', async () => {
    const { service, dir } = await fixture()
    await writeFile(join(dir, 'file.txt'), 'before')
    const { revision } = await service.readFile('file.txt')
    const results = await Promise.allSettled([
      service.saveFile('file.txt', 'A'.repeat(10000), revision),
      service.saveFile('file.txt', 'B'.repeat(20000), revision),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await readFile(join(dir, 'file.txt'), 'utf8')).toBe('A'.repeat(10000))
  })
  it('keeps externally modified contents intact', async () => {
    const { service, dir } = await fixture()
    await writeFile(join(dir, 'file.txt'), 'before')
    const { revision } = await service.readFile('file.txt')
    await writeFile(join(dir, 'file.txt'), 'external')
    await expect(service.saveFile('file.txt', 'draft', revision)).rejects.toThrow('changed on disk')
    expect(await readFile(join(dir, 'file.txt'), 'utf8')).toBe('external')
  })
})
it('terminal shutdown rejects a queued session start before it spawns Pi', async () => {
  const { service, dir } = await fixture()
  let finish!: () => void
  const stopping = new Promise<void>((resolve) => {
    finish = resolve
  })
  const create = vi.fn()
  ;(service as any).sdk = { SessionManager: { create } }
  ;(service as any).lifecycle = stopping
  service.preferences.workspaces = [{ path: dir, name: 'test' }]
  const queued = service.addWorkspace(dir)
  const shutdown = service.shutdown()
  finish()
  await expect(queued).rejects.toThrow('shutting down')
  await shutdown
  expect(create).not.toHaveBeenCalled()
})

it('returns display-only sizes for regular workspace paths and rejects traversal', async () => {
  const { service, dir } = await fixture()
  await writeFile(join(dir, 'note.txt'), 'hello')
  const sizes = await service.fileSizes(undefined as any, [
    'note.txt',
    'missing.txt',
    '..',
    '../outside',
    '/etc/passwd',
    '.',
  ])
  expect(sizes['note.txt']).toBe(5)
  expect(sizes['missing.txt']).toBeNull()
  expect(sizes['..']).toBeNull()
  expect(sizes['../outside']).toBeNull()
  expect(sizes['/etc/passwd']).toBeNull()
  expect(sizes['.']).toBeNull()
  await expect(service.fileSizes(undefined as any, Array(51).fill('note.txt'))).rejects.toThrow(
    'Invalid file list',
  )
  await expect(service.fileSizes(undefined as any, ['note.txt\0'])).rejects.toThrow(
    'Invalid file list',
  )
})
