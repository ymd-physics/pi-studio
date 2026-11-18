import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const policyKey = Symbol.for('pi-desktop.compaction-policy')

/** Runs after native extension loading, and again on every native reload. */
export function compactionPolicyOverride(bundledPath) {
  return (result) => {
    const bundled = result.extensions.find((extension) => extension.resolvedPath === resolve(bundledPath))
    if (!bundled) throw new Error(`Bundled compaction extension failed to load: ${bundledPath}`)
    const others = result.extensions.filter((extension) => extension !== bundled)
    if (others.some((extension) => !(extension.handlers instanceof Map))) {
      throw new Error('Installed Pi lacks native extension handler inspection')
    }
    globalThis[policyKey] = {
      externalCompaction: others.some((extension) => extension.handlers.has('session_before_compact')),
      externalReplay: others.some(
        (extension) =>
          extension.handlers.has('session_before_compact') &&
          extension.handlers.has('before_provider_request'),
      ),
    }
    return result
  }
}

export async function startDesktopRpc(sdkPath, sessionFile) {
  if (!sdkPath || !sessionFile) throw new Error('Expected installed Pi SDK path and session file')
  const dist = dirname(resolve(sdkPath))
  // Embedding changes argv[1] from Pi's CLI to this bridge. Use the plugin's
  // documented host-discovery contract, before extensions cache their SDK root.
  // Never inherit a different parent's installation or resolve another Pi on PATH.
  process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = dirname(dist)
  process.env.PI_PACKAGE_DIR = dirname(dist)
  const load = (relative) => import(pathToFileURL(join(dist, relative)).href)
  const sdk = await import(pathToFileURL(resolve(sdkPath)).href)
  for (const name of [
    'createAgentSessionServices',
    'createAgentSessionFromServices',
    'createAgentSessionRuntime',
    'getAgentDir',
  ]) {
    if (typeof sdk[name] !== 'function') throw new Error(`Installed Pi lacks native API ${name}`)
  }
  const [{ runRpcMode }, { builtInExtensions }, { takeOverStdout }, http, { resolveModelScope }] =
    await Promise.all([
      load('modes/rpc/rpc-mode.js'),
      load('extensions/index.js'),
      load('core/output-guard.js'),
      load('core/http-dispatcher.js'),
      load('core/model-resolver.js'),
    ])
  if (typeof runRpcMode !== 'function' || !Array.isArray(builtInExtensions)) {
    throw new Error('Installed Pi lacks native RPC or built-in extension factories')
  }
  takeOverStdout()
  const resources = dirname(fileURLToPath(import.meta.url))
  const bundledPath = join(resources, 'codex-compaction/index.ts')
  const agentDir = sdk.getAgentDir()
  const sessionManager = sdk.SessionManager.open(sessionFile)
  const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true })
    http.applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy)
    http.configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs())
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntimeSignal: AbortSignal.timeout(15_000),
      resourceLoaderOptions: {
        additionalExtensionPaths: [join(resources, 'desktop-session-guard.mjs'), bundledPath],
        extensionFactories: builtInExtensions,
        extensionsOverride: compactionPolicyOverride(bundledPath),
      },
    })
    const extensions = services.resourceLoader.getExtensions()
    const diagnostics = [
      ...services.diagnostics,
      ...extensions.errors.map(({ path, error }) => ({
        type: 'error',
        message: `Failed to load extension "${path}": ${error}`,
      })),
      ...(extensions.warnings ?? []).map(({ path, warning }) => ({
        type: 'warning',
        message: `${path}: ${warning}`,
      })),
    ]
    for (const diagnostic of diagnostics) console.error(`${diagnostic.type}: ${diagnostic.message}`)
    // Like the native CLI, report individual resource failures without disabling the
    // remaining extensions. The required bundled bridge is checked by the override.
    const patterns = settingsManager.getEnabledModels()
    const scopedModels = patterns?.length
      ? await resolveModelScope(patterns, services.modelRuntime, { signal: AbortSignal.timeout(15_000) })
      : []
    return {
      ...(await sdk.createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        scopedModels,
      })),
      services,
      diagnostics,
    }
  }
  const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
    cwd: sessionManager.getCwd(),
    agentDir,
    sessionManager,
  })
  await runRpcMode(runtime)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDesktopRpc(process.argv[2], process.argv[3]).catch((error) => {
    console.error(
      `Pi Studio native RPC startup failed: ${error?.stack || error}. Update or repair the installed Pi; no fallback agent was started.`,
    )
    process.exit(1)
  })
}
