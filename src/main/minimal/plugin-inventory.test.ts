import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { readPluginInventory as inspect } from './plugin-inventory'
import { formatPluginWarning } from '../../../packages/shared/plugins'
import { uiText } from '../../../packages/shared/language'

async function readPluginInventory(...args: Parameters<typeof inspect>) {
  const result = await inspect(...args)
  return { ...result, warnings: result.warnings.map(w => formatPluginWarning(w, uiText('en'))) }
}

const installation = { sdk: '/never/import.js', cli: '/never/run.js', node: '/never/node', version: '1.5.0' }
let root: string
let agent: string
async function file(path: string, value: unknown) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'plugin-inventory-'))
  agent = join(root, 'agent')
  vi.stubEnv('PI_CODING_AGENT_DIR', agent)
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

describe('readPluginInventory', () => {
  it('renders the same snapshot in Chinese and English without translating literal package names or glob patterns', async () => {
    const source = 'npm:bad {name}', pattern = 'extensions/*.ts'
    await file(join(agent, 'settings.json'), { packages: [source], extensions: [pattern] })
    const result = await inspect(installation)
    expect(result.warnings.map(w => formatPluginWarning(w, uiText('zh-CN')))).toEqual(expect.arrayContaining([
      `不支持此 npm 软件包来源：${source}`, `未展开扩展路径通配符：${pattern}`,
    ]))
    expect(result.warnings.map(w => formatPluginWarning(w, uiText('en')))).toContain(`Unsupported npm source: ${source}`)
  })
  it('reads installed manifest versions without treating configured constraints as installed versions', async () => {
    await file(join(agent, 'settings.json'), { packages: ['npm:pi-web-access@^0.47', 'npm:pi-subagents@^0.87'] })
    await file(join(agent, 'npm/node_modules/pi-web-access/package.json'), { name: 'pi-web-access', version: '0.47.0', main: './must-not-execute.js' })
    await file(join(agent, 'npm/node_modules/pi-web-access/must-not-execute.js'), 'throw new Error("do not import")')
    const result = await readPluginInventory(installation)
    expect(result.global.find(entry => entry.adapted === 'web-access')).toMatchObject({ version: '0.47.0', state: 'installed' })
    expect(result.global.find(entry => entry.adapted === 'subagents')?.version).toBeUndefined()
    await file(join(agent, 'npm/node_modules/pi-web-access/package.json'), { version: 'invalid\nversion' })
    expect((await readPluginInventory(installation)).global.find(entry => entry.adapted === 'web-access')?.version).toBeUndefined()
  })
  it('reads global only without executing resources and normalizes versioned recommended packages', async () => {
    await file(join(agent, 'settings.json'), { packages: ['npm:@gotgenes/pi-permission-system@1.2.3', 'npm:@juicesharp/rpiv-todo@latest', 'npm:pi-subagents@^2'] })
    await mkdir(join(agent, 'npm/node_modules/@gotgenes/pi-permission-system'), { recursive: true })
    await file(join(agent, 'extensions/unsafe.ts'), 'throw new Error("must not execute")')
    const result = await readPluginInventory(installation)
    expect(result.local).toEqual([])
    expect(result.workspace).toBeUndefined()
    expect(result.global.filter(entry => entry.adapted)).toHaveLength(4)
    expect(result.global.find(entry => entry.adapted === 'permissions')?.state).toBe('installed')
    expect(result.global.find(entry => entry.adapted === 'todo')?.state).toBe('configured')
    expect(result.global.find(entry => entry.name === 'unsafe.ts')?.state).toBe('installed')
  })
  it('resolves workspace packages relative to .pi and git refs independently of cwd', async () => {
    const workspace = join(root, 'project')
    const local = join(workspace, '.pi')
    await file(join(local, 'settings.json'), { packages: ['../plugin', 'git:github.com/acme/plugin@main', 'npm:absent', { source: 'npm:disabled', extensions: [], skills: [], prompts: [], themes: [] }] })
    await mkdir(join(workspace, 'plugin'), { recursive: true })
    await mkdir(join(local, 'git/github.com/acme/plugin'), { recursive: true })
    const result = await readPluginInventory(installation, workspace)
    expect(result.local.slice(0, 4).map(entry => entry.state)).toEqual(['installed', 'installed', 'missing', 'disabled'])
    expect(result.global.some(entry => entry.source === '../plugin')).toBe(false)
    await expect(readPluginInventory(installation, './relative')).rejects.toThrow('absolute')
  })
  it('discovers auto manifest/index entries and exact disable overrides', async () => {
    await file(join(agent, 'settings.json'), { extensions: ['-extensions/nested/index.ts'] })
    await file(join(agent, 'extensions/nested/index.ts'), 'throw 0')
    await file(join(agent, 'extensions/package/package.json'), { pi: { extensions: ['entry.js'] } })
    await file(join(agent, 'extensions/package/entry.js'), 'throw 0')
    const result = await readPluginInventory(installation)
    expect(result.global.find(entry => entry.name === 'index.ts')?.state).toBe('disabled')
    expect(result.global.find(entry => entry.name === 'entry.js')?.state).toBe('installed')
    expect(result.warnings).toEqual([])
  })
  it('surfaces unreadable/invalid settings without falsely reporting recommendations absent', async () => {
    await file(join(agent, 'settings.json'), '{broken')
    const result = await readPluginInventory(installation)
    expect(result.warnings.some(warning => warning.includes('settings.json'))).toBe(true)
    expect(result.global.every(entry => entry.state === 'configured')).toBe(true)
  })
  it('rejects oversized settings and honors root auto-extension indexes', async () => {
    await file(join(agent, 'settings.json'), ' '.repeat(1024 * 1024 + 1))
    await file(join(agent, 'extensions/index.js'), 'throw 0')
    await file(join(agent, 'extensions/not-autoloaded.js'), 'throw 0')
    const result = await readPluginInventory(installation)
    expect(result.warnings.some(warning => warning.includes('settings.json'))).toBe(true)
    expect(result.global.some(entry => entry.name === 'index.js')).toBe(true)
    expect(result.global.some(entry => entry.name === 'not-autoloaded.js')).toBe(false)
  })
  it('identifies auto and explicit directory integrations by manifest name', async () => {
    await file(join(agent, 'settings.json'), { extensions: ['./todo'], packages: ['./permission'] })
    await file(join(agent, 'extensions/unrelated-folder/package.json'), { name: 'pi-subagents' })
    await file(join(agent, 'extensions/unrelated-folder/index.ts'), 'throw 0')
    await file(join(agent, 'todo/package.json'), { name: '@juicesharp/rpiv-todo', pi: { extensions: ['entry.js'] } })
    await file(join(agent, 'todo/entry.js'), 'throw 0')
    await file(join(agent, 'permission/package.json'), { name: '@gotgenes/pi-permission-system' })
    const result = await readPluginInventory(installation)
    expect(result.global.filter(entry => entry.adapted)).toHaveLength(4)
    expect(result.global.find(entry => entry.adapted === 'subagents')).toMatchObject({ name: 'pi-subagents', state: 'installed' })
    expect(result.global.find(entry => entry.adapted === 'todo')).toMatchObject({ name: '@juicesharp/rpiv-todo', state: 'installed' })
    expect(result.global.find(entry => entry.adapted === 'permissions')).toMatchObject({ state: 'installed' })
  })
  it('keeps recommendations global but includes present and configured local packages', async () => {
    const workspace = join(root, 'project')
    expect((await readPluginInventory(installation, workspace)).local).toEqual([])
    await file(join(workspace, '.pi/settings.json'), { packages: ['npm:pi-subagents'] })
    await mkdir(join(workspace, '.pi/npm/node_modules/@juicesharp/rpiv-todo'), { recursive: true })
    const result = await readPluginInventory(installation, workspace)
    expect(result.local).toHaveLength(2)
    expect(result.local.find(entry => entry.adapted === 'subagents')?.state).toBe('missing')
    expect(result.local.find(entry => entry.adapted === 'todo')?.state).toBe('installed')
  })
  it.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for a writer', async () => {
    await mkdir(agent, { recursive: true })
    execFileSync('mkfifo', [join(agent, 'settings.json')])
    const result = await readPluginInventory(installation)
    expect(result.warnings.some(warning => warning.includes('settings.json'))).toBe(true)
    expect(result.global.every(entry => entry.state === 'configured')).toBe(true)
  }, 2000)
  it('keeps builtin references configured instead of treating them as filesystem paths', async () => {
    await file(join(agent, 'settings.json'), { extensions: ['builtin:example', 'builtin:off', '-builtin:off'], packages: ['builtin:package'] })
    const result = await readPluginInventory(installation)
    expect(result.global.find(entry => entry.source === 'builtin:example')?.state).toBe('configured')
    expect(result.global.find(entry => entry.source === 'builtin:off')?.state).toBe('disabled')
    expect(result.global.find(entry => entry.source === 'builtin:package')?.state).toBe('configured')
    expect(result.global.some(entry => entry.source.includes('/builtin:'))).toBe(false)
  })
  it('does not recurse into arbitrary auto-extension subtrees', async () => {
    await file(join(agent, 'extensions/container/deep/package.json'), { name: 'pi-subagents' })
    await file(join(agent, 'extensions/container/deep/index.ts'), 'throw 0')
    const result = await readPluginInventory(installation)
    expect(result.global.some(entry => entry.source.includes('/deep/'))).toBe(false)
    expect(result.global.find(entry => entry.adapted === 'subagents')?.state).toBe('missing')
  })
  it('bounds settings and discovery and reports unsupported filters', async () => {
    await file(join(agent, 'settings.json'), { extensions: ['!**/ignored.ts'], packages: Array.from({ length: 260 }, (_, i) => `npm:p${i}`) })
    const result = await readPluginInventory(installation)
    expect(result.warnings.some(warning => warning.includes('truncated'))).toBe(true)
    expect(result.global.length).toBe(260)
    expect(result.warnings.some(warning => warning.includes('glob not evaluated'))).toBe(true)
  })
})
