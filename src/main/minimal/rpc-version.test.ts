import { describe, expect, it } from 'vitest'
import { usesNativeRpcBridge } from './rpc-version'

// Importing the bridge must not read auth, create sessions, or start RPC.
// @ts-expect-error Packaged ESM resource is deliberately not compiled by TypeScript.
import { compactionPolicyOverride, startDesktopRpc } from '../../../resources/desktop-rpc.mjs'

const policyKey = Symbol.for('pi-desktop.compaction-policy')
const bundledPath = '/resources/codex-compaction/index.ts'
const extension = (resolvedPath: string, hooks: string[]) => ({
  resolvedPath,
  handlers: new Map(hooks.map((hook) => [hook, [() => {}]])),
})

describe('RPC version selection', () => {
  it.each(['0.60.0', '1.3.9', '1.4.0-rc.1'])('preserves CLI for %s', (version) => {
    expect(usesNativeRpcBridge(version)).toBe(false)
  })
  it.each(['1.4.0', '1.4.0+build', '1.5.0', '2.0.0'])('uses native bridge for %s', (version) => {
    expect(usesNativeRpcBridge(version)).toBe(true)
  })
  it('rejects an unknown version instead of silently picking a runtime', () => {
    expect(() => usesNativeRpcBridge('unknown')).toThrow('invalid version')
  })
})

describe('desktop-rpc native extension policy', () => {
  it('inspects actual handlers, preserves extensions, and refreshes on reload', () => {
    const override = compactionPolicyOverride(bundledPath)
    const bundled = extension(bundledPath, ['session_before_compact', 'before_provider_request'])
    const result = { extensions: [bundled], errors: [], runtime: {} }
    expect(override(result)).toBe(result)
    expect(Reflect.get(globalThis, policyKey)).toEqual({ externalCompaction: false, externalReplay: false })
    result.extensions.push(extension('/custom.ts', ['session_before_compact']))
    override(result)
    expect(Reflect.get(globalThis, policyKey)).toEqual({ externalCompaction: true, externalReplay: false })
    result.extensions[1].handlers.set('before_provider_request', [() => {}])
    override(result)
    expect(Reflect.get(globalThis, policyKey)).toEqual({ externalCompaction: true, externalReplay: true })
    result.extensions.pop()
    override(result)
    expect(Reflect.get(globalThis, policyKey)).toEqual({ externalCompaction: false, externalReplay: false })
    Reflect.deleteProperty(globalThis, policyKey)
  })
  it('requires both hooks on the same external extension for replay ownership', () => {
    compactionPolicyOverride(bundledPath)({
      extensions: [
        extension(bundledPath, []),
        extension('/a.ts', ['session_before_compact']),
        extension('/b.ts', ['before_provider_request']),
      ],
    })
    expect(Reflect.get(globalThis, policyKey)).toEqual({ externalCompaction: true, externalReplay: false })
    Reflect.deleteProperty(globalThis, policyKey)
  })
  it('fails explicitly when the bundled extension or native handler map is absent', () => {
    const override = compactionPolicyOverride(bundledPath)
    expect(() => override({ extensions: [] })).toThrow('failed to load')
    expect(() => override({ extensions: [extension(bundledPath, []), { resolvedPath: '/bad.ts' }] })).toThrow(
      'handler inspection',
    )
  })
  it('validates bridge arguments without reading native state', async () => {
    await expect(startDesktopRpc()).rejects.toThrow('Expected installed Pi SDK path')
  })
})
