import { open, opendir, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { PluginEntry, PluginInventory } from '../../../packages/shared/plugins'
import type { PiInstallation } from './runtime'
import { PLUGIN_BASELINES, type AdaptedPlugin } from '../../../packages/shared/compatibility'

const recommended = Object.fromEntries(Object.entries(PLUGIN_BASELINES).map(([key, value]) => [value.package, key])) as Record<string, AdaptedPlugin>
const manifestVersion = (value: unknown) => typeof value === 'string' && value.length <= 100 && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value) ? value : undefined
const limit = 256
const expand = (path: string) => path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Reads presence only. Native package resolution can install packages, and settings APIs can write;
 * neither is safe for Preferences. No SDK or extension code is imported here. */
export async function readPluginInventory(installation: PiInstallation, workspace?: string): Promise<PluginInventory> {
  const agentDir = resolve(expand(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')))
  const result: PluginInventory = { agentDir, global: [], local: [], warnings: [] }
  if (workspace !== undefined) {
    if (!isAbsolute(expand(workspace))) throw new Error('Plugin inventory workspace must be absolute')
    result.workspace = resolve(expand(workspace))
  }
  const warn = (message: string) => { if (!result.warnings.includes(message)) result.warnings.push(message) }
  const failure = (path: string, error: unknown) => warn(`Cannot inspect ${path}: ${(error as NodeJS.ErrnoException).code || 'invalid data'}`)
  let operations = 0
  const budget = () => { if (++operations > 4096) throw new Error('Inventory filesystem operation limit reached') }
  async function presence(path: string): Promise<boolean | undefined> {
    try { budget(); await stat(path); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      failure(path, error); return undefined
    }
  }
  async function json(path: string): Promise<Record<string, unknown> | undefined> {
    try {
      budget()
      // Reject FIFOs via fstat without blocking in open while waiting for a writer.
      const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Not a bounded regular file')
        const buffer = Buffer.alloc(1024 * 1024 + 1)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > 1024 * 1024) throw new Error('File too large')
        const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, ''))
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
        return object(value)
      } finally { await file.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      failure(path, error); return undefined
    }
  }
  async function children(path: string): Promise<string[]> {
    const names: string[] = []
    try {
      budget()
      const dir = await opendir(path)
      for await (const entry of dir) {
        if (names.length === limit) { warn(`Inventory truncated at ${limit} entries: ${path}`); break }
        names.push(entry.name)
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure(path, error) }
    return names.sort()
  }
  function bounded(value: unknown, label: string): unknown[] {
    if (value === undefined) return []
    if (!Array.isArray(value)) { warn(`Invalid ${label}: expected array`); return [] }
    if (value.length > limit) warn(`Inventory truncated at ${limit} entries: ${label}`)
    return value.slice(0, limit)
  }
  function packagePath(source: string, base: string): { name: string; path?: string; npm?: boolean } {
    if (source.startsWith('builtin:')) return { name: source }
    if (source.startsWith('npm:')) {
      const match = source.slice(4).trim().match(/^(@[^/@\s]+\/[^/@\s]+|[^/@\s]+)(?:@[^\s]+)?$/)
      if (match && !match[1].split('/').some(part => part === '.' || part === '..'))
        return { name: match[1], path: join(base, 'npm', 'node_modules', match[1]), npm: true }
      warn(`Unsupported npm source: ${source}`); return { name: source }
    }
    if (source.startsWith('git:') || /^(https?|ssh):\/\//.test(source)) {
      let text = source.replace(/^git:(?!\/\/)/, '').replace(/^git@([^:]+):/, '$1/')
      if (/^(https?|ssh|git):\/\//.test(text)) {
        try { const url = new URL(text); text = `${url.hostname}${url.pathname}` } catch { /* reported below */ }
      }
      text = text.replace(/@.*$/, '').replace(/#.*$/, '').replace(/\.git$/, '')
      text = text.replace(/^github:/, 'github.com/').replace(/^gitlab:/, 'gitlab.com/').replace(/^bitbucket:/, 'bitbucket.org/')
      if (/^[\w.-]+\/[\w.-]+\/[\w./-]+$/.test(text) && !text.split('/').some(part => part === '..' || part === '.'))
        return { name: basename(text), path: join(base, 'git', text) }
      warn(`Unsupported git source: ${source}`); return { name: source }
    }
    return { name: basename(source), path: resolve(base, expand(source)) }
  }
  async function scope(scope: 'global' | 'local', base: string) {
    const entries = result[scope]
    const settings = await json(join(base, 'settings.json'))
    const add = (name: string, source: string, state: PluginEntry['state'], description?: string, version?: string) => {
      const existing = entries.find(entry => entry.source === source)
      if (existing) return
      entries.push({ id: `${scope}:${source}`, name, source, scope, state,
        ...(Object.hasOwn(recommended, name) ? { adapted: recommended[name as keyof typeof recommended] } : {}),
        ...(description ? { description } : {}), ...(version ? { version } : {}) })
    }
    for (const raw of bounded(settings?.packages, `${scope} packages`)) {
      const config = object(raw)
      const source = typeof raw === 'string' ? raw : config.source
      if (typeof source !== 'string' || !source) { warn(`Invalid ${scope} package source`); continue }
      const parsed = packagePath(source, base)
      const installed = parsed.path ? await presence(parsed.path) : undefined
      let version: string | undefined
      if (installed && parsed.path) {
        try {
          budget()
          if ((await stat(parsed.path)).isDirectory()) {
            const manifest = await json(join(parsed.path, 'package.json'))
            if (!parsed.npm && typeof manifest?.name === 'string') parsed.name = manifest.name
            version = manifestVersion(manifest?.version)
          }
        } catch (error) { failure(parsed.path, error) }
      }
      const filters = ['extensions', 'skills', 'prompts', 'themes'].filter(key => config[key] !== undefined)
      const disabled = filters.length === 4 && filters.every(key => Array.isArray(config[key]) && (config[key] as unknown[]).length === 0)
      if (filters.length && !disabled) warn(`Resource filters are not evaluated for ${source}; package presence is not activation`)
      if (parsed.npm && scope === 'global' && installed === false) warn('Legacy global npm/pnpm packages are not inspected (requires executing a package manager)')
      add(parsed.name, source, disabled ? 'disabled' : installed ? 'installed' : installed === false && !(parsed.npm && scope === 'global') ? 'missing' : 'configured',
        installed === undefined ? 'Presence could not be verified' : undefined, version)
    }
    const patterns = bounded(settings?.extensions, `${scope} extensions`).filter((entry): entry is string => {
      if (typeof entry === 'string') return true
      warn(`Invalid ${scope} extension entry`); return false
    })
    for (const pattern of patterns) if (/[*?{}[\]]/.test(pattern)) warn(`Extension glob not evaluated: ${pattern}`)
    async function extension(path: string, manifestName?: string, version?: string) {
      let disabled = false
      for (const pattern of patterns) {
        if (/[*?{}[\]]/.test(pattern)) { warn(`Extension glob not evaluated: ${pattern}`); continue }
        if (resolve(base, expand(pattern.replace(/^[!+-]/, ''))) === path && /^[!+-]/.test(pattern)) disabled = !pattern.startsWith('+')
      }
      const exists = await presence(path)
      add(manifestName || basename(path), path, disabled ? 'disabled' : exists ? 'installed' : exists === false ? 'missing' : 'configured', undefined, version)
    }
    async function directoryEntries(path: string): Promise<boolean> {
      try { budget(); if (!(await stat(path)).isDirectory()) return false } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure(path, error)
        return false
      }
      const manifest = await json(join(path, 'package.json'))
      const manifestName = typeof manifest?.name === 'string' ? manifest.name : undefined
      const declared = bounded(object(manifest?.pi).extensions, `${path} pi.extensions`)
      let found = false
      for (const value of declared) if (typeof value === 'string') {
        const target = resolve(path, value)
        if (await presence(target)) { await extension(target, manifestName, manifestVersion(manifest?.version)); found = true }
      }
      if (found) return true
      for (const name of ['index.ts', 'index.js']) if (await presence(join(path, name))) { await extension(join(path, name), manifestName, manifestVersion(manifest?.version)); return true }
      return false
    }
    for (const pattern of patterns) {
      if (/^[!+-]/.test(pattern)) continue
      if (/[*?{}[\]]/.test(pattern)) { warn(`Extension glob not evaluated: ${pattern}`); continue }
      if (pattern.startsWith('builtin:')) {
        const overrides = patterns.filter(value => /^[!+-]/.test(value) && value.slice(1) === pattern)
        const disabled = overrides.length > 0 && !overrides[overrides.length - 1].startsWith('+')
        add(pattern, pattern, disabled ? 'disabled' : 'configured', 'Built-in reference; availability is not verified without loading the SDK')
        continue
      }
      const path = resolve(base, expand(pattern))
      // Explicit extension directories may provide a manifest or index; never execute them.
      if (!(await directoryEntries(path))) await extension(path)
    }
    const auto = join(base, 'extensions')
    if (!(await directoryEntries(auto))) {
      for (const name of await children(auto)) {
        if (name.startsWith('.') || name === 'node_modules') continue
        const path = join(auto, name)
        if (/\.(ts|js)$/.test(name)) await extension(path)
        else await directoryEntries(path)
      }
    }
    for (const name of ['.gitignore', '.ignore', '.piignore']) if (await presence(join(auto, name))) warn(`Auto-extension ignore rules not evaluated: ${join(auto, name)}`)
    for (const [name, adapted] of Object.entries(recommended)) {
      if (entries.some(entry => entry.adapted === adapted)) continue
      const source = `npm:${name}`
      const exists = await presence(join(base, 'npm', 'node_modules', name))
      if (scope === 'local' && exists !== true) continue
      add(name, source, exists ? 'installed' : exists === false && settings !== undefined ? 'missing' : 'configured',
        exists ? 'Present in managed packages; not configured' : 'Recommended integration; presence outside managed packages is not verified',
        exists ? manifestVersion((await json(join(base, 'npm', 'node_modules', name, 'package.json')))?.version) : undefined)
    }
  }
  // Installation is deliberately not imported: inventory must remain independent of SDK initialization.
  if (!installation.version) warn('Pi installation version unavailable; inventory uses native Pi managed layout')
  await scope('global', agentDir)
  if (result.workspace) await scope('local', join(result.workspace, '.pi'))
  return result
}
