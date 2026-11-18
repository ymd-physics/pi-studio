import { expect, it } from 'vitest'
import { commandCatalog, routeCommand } from './commands'

it('keeps every discovered resource including invocation aliases and native overrides', () => {
  const native = [
    ...Array.from({ length: 20 }, (_, i) => ({ name: `command-${i}`, source: 'extension' })),
    { name: 'perm', source: 'extension' },
    { name: 'perm:1', source: 'extension' },
    { name: 'reload', source: 'extension' },
    { name: 'model', source: 'extension' },
  ]
  const catalog = commandCatalog(native)
  expect(native.every((c) => catalog.includes(c))).toBe(true)
  expect(catalog.filter((c) => c.name === 'reload')).toHaveLength(1)
  expect(routeCommand('/perm workspace', native)).toEqual({ kind: 'native', name: 'perm', args: 'workspace' })
  expect(routeCommand('/perm:1 default', native).kind).toBe('native')
  expect(routeCommand('/reload', native).kind).toBe('native')
  expect(routeCommand('/model custom', native).kind).toBe('native')
})
it('allows extension input hooks and separates native RPC adapters from TUI-only commands', () => {
  expect(routeCommand('/hook-only any args', []).kind).toBe('native')
  expect(routeCommand('/mcp', []).kind).toBe('native')
  expect(routeCommand('/llama', []).kind).toBe('native')
  expect(routeCommand('/reload', []).kind).toBe('desktop')
  expect(routeCommand('/clone', []).kind).toBe('desktop')
  expect(routeCommand('/login', []).kind).toBe('terminal')
  expect(routeCommand('/model', []).kind).toBe('terminal')
  expect(routeCommand('ordinary prompt', []).kind).toBe('native')
})
