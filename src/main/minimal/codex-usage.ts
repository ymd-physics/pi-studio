import { createHash } from 'node:crypto'
import type {
  CodexUsageReason,
  CodexUsageSnapshot,
  CodexUsageWindow,
} from '../../../packages/shared/codex-usage'
import { discoverPi, loadSessionManager } from './runtime'

const PROVIDER = 'openai-codex'
const ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage'
const INTERVAL = 60_000

/** Narrow public SDK seam. Inject only a native, non-extension ModelRuntime. */
export interface CodexUsageRuntime {
  getProvider(
    id: string,
  ): { baseUrl?: string; auth: { oauth?: { isSubscription?: boolean }; apiKey?: unknown } } | undefined
  checkAuth(id: string, options: { signal: AbortSignal }): Promise<{ type: string } | undefined>
  getAuth(
    id: string,
    options: { signal: AbortSignal },
  ): Promise<
    | {
        source?: string
        auth: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> }
      }
    | undefined
  >
}

export async function loadCodexUsageRuntime(signal: AbortSignal): Promise<CodexUsageRuntime> {
  const sdk = await loadSessionManager(await discoverPi())
  if (!sdk.ModelRuntime?.create) throw new UsageFailure('unsupported-runtime')
  // Ignore models.json overrides and extension providers. Native SDK owns credential refresh/storage.
  const runtime = await sdk.ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
    signal,
  })
  if (!runtime.getProvider || !runtime.checkAuth || !runtime.getAuth)
    throw new UsageFailure('unsupported-runtime')
  return runtime
}

class UsageFailure extends Error {
  constructor(readonly reason: CodexUsageReason) {
    super(reason)
  }
}

function official(url: string | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return (
      parsed.origin === 'https://chatgpt.com' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      /^\/backend-api\/?$/.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

function numeric(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

export function normalizeCodexUsage(payload: unknown): CodexUsageWindow[] {
  const rate = (payload as { rate_limit?: Record<string, unknown> } | null)?.rate_limit
  const windows: CodexUsageWindow[] = []
  for (const name of ['primary_window', 'secondary_window']) {
    const window = rate?.[name] as Record<string, unknown> | undefined
    const duration = numeric(window?.limit_window_seconds)
    const used = numeric(window?.used_percent)
    if ((duration !== 18000 && duration !== 604800) || used === undefined) continue
    if (windows.some((entry) => entry.durationSeconds === duration))
      throw new UsageFailure('invalid-response')
    const reset = numeric(window?.reset_at)
    windows.push({
      durationSeconds: duration,
      remainingPercent: 100 - Math.min(100, Math.max(0, used)),
      resetsAt: reset !== undefined && reset >= 0 ? reset : null,
    })
  }
  if (!windows.length) throw new UsageFailure('invalid-response')
  return windows.sort((a, b) => a.durationSeconds - b.durationSeconds)
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new UsageFailure('invalid-response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 65536) throw new UsageFailure('invalid-response')
      chunks.push(value)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new UsageFailure('invalid-response')
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export interface CodexUsageOptions {
  loadRuntime?: (signal: AbortSignal) => Promise<CodexUsageRuntime>
  fetch?: typeof fetch
  changed?: (snapshot: CodexUsageSnapshot) => void
}

/** One app-owned instance; no sessions or plugins are created. start/stop are idempotent. */
export class CodexUsageService {
  private value: CodexUsageSnapshot = {
    provider: PROVIDER,
    state: 'unavailable',
    reason: 'not-started',
    capturedAt: null,
    stale: false,
    windows: [],
  }
  private timer?: ReturnType<typeof setInterval>
  private controller?: AbortController
  private running = false
  private generation = 0
  private identity?: string
  private runtime?: CodexUsageRuntime
  constructor(private readonly options: CodexUsageOptions = {}) {}

  snapshot(): CodexUsageSnapshot {
    return structuredClone(this.value)
  }
  private publish(value: CodexUsageSnapshot): void {
    this.value = value
    try {
      this.options.changed?.(this.snapshot())
    } catch {
      /* UI observers cannot break polling. */
    }
  }
  private unavailable(reason: CodexUsageReason, retain = false): void {
    this.publish({
      provider: PROVIDER,
      state: retain ? 'error' : 'unavailable',
      reason,
      capturedAt: retain ? this.value.capturedAt : null,
      stale: retain && this.value.windows.length > 0,
      windows: retain ? this.value.windows : [],
    })
  }
  start(): void {
    if (this.running) return
    this.running = true
    this.generation++
    this.timer = setInterval(() => {
      void this.poll()
    }, INTERVAL)
    void this.poll()
  }
  stop(): void {
    if (!this.running) return
    this.running = false
    this.generation++
    clearInterval(this.timer)
    this.timer = undefined
    this.controller?.abort()
    this.controller = undefined
    this.identity = undefined
    this.unavailable('stopped')
  }
  private async credential(runtime: CodexUsageRuntime, signal: AbortSignal): Promise<string> {
    const provider = runtime.getProvider(PROVIDER)
    if (!provider || (await runtime.checkAuth(PROVIDER, { signal }))?.type !== 'oauth') {
      const modern = runtime.getProvider('openai')
      if (
        modern?.auth.oauth?.isSubscription &&
        (await runtime.checkAuth('openai', { signal }))?.type === 'oauth'
      )
        throw new UsageFailure('unsupported-subscription')
      throw new UsageFailure('no-subscription')
    }
    if (!official(provider.baseUrl) || !provider.auth.oauth?.isSubscription || provider.auth.apiKey)
      throw new UsageFailure('untrusted-origin')
    const result = await runtime.getAuth(PROVIDER, { signal })
    signal.throwIfAborted()
    if (!result || result.source !== 'OAuth') throw new UsageFailure('auth-unavailable')
    if (result.auth.baseUrl && !official(result.auth.baseUrl)) throw new UsageFailure('untrusted-origin')
    // Legacy native toAuth returns apiKey; reject overrides instead of forwarding arbitrary headers.
    if (Object.keys(result.auth.headers ?? {}).length) throw new UsageFailure('untrusted-origin')
    const token = result.auth.apiKey
    if (!token || /\s/.test(token)) throw new UsageFailure('auth-unavailable')
    return token
  }
  private async poll(): Promise<void> {
    if (!this.running || this.controller) return
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    const current = () => this.running && generation === this.generation && !controller.signal.aborted
    let verified = false
    const timeout = setTimeout(() => {
      if (current()) this.unavailable('timeout')
      controller.abort()
    }, INTERVAL)
    try {
      const runtime = this.runtime ?? await (this.options.loadRuntime ?? loadCodexUsageRuntime)(controller.signal)
      if (!current()) return
      this.runtime = runtime
      const token = await this.credential(runtime, controller.signal)
      if (!current()) return
      const identity = createHash('sha256').update(token).digest('hex')
      if (this.identity !== identity) this.unavailable('account-changed')
      this.identity = identity
      verified = true
      const response = await (this.options.fetch ?? fetch)(ENDPOINT, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      })
      if (!current()) {
        await response.body?.cancel().catch(() => {})
        return
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new UsageFailure(
          response.status === 401
            ? 'unauthorized'
            : response.status === 429
              ? 'rate-limited'
              : 'request-failed',
        )
      }
      const windows = normalizeCodexUsage(await boundedJson(response))
      if (!current()) return
      // Re-read native auth before publishing: logout/account switches invalidate in-flight data.
      const latest = await this.credential(this.runtime, controller.signal)
      if (!current()) return
      if (latest !== token) {
        this.identity = undefined
        this.unavailable('account-changed')
        return
      }
      this.publish({
        provider: PROVIDER,
        state: 'ready',
        reason: null,
        capturedAt: Date.now(),
        stale: false,
        windows,
      })
    } catch (error) {
      if (current()) {
        const reason = error instanceof UsageFailure ? error.reason : 'request-failed'
        let retain = verified && ['request-failed', 'rate-limited', 'invalid-response'].includes(reason)
        if (retain && this.runtime) {
          try {
            const latest = await this.credential(this.runtime, controller.signal)
            retain = createHash('sha256').update(latest).digest('hex') === this.identity
          } catch {
            retain = false
          }
        }
        if (current()) this.unavailable(reason, retain)
      }
    } finally {
      clearTimeout(timeout)
      if (this.controller === controller) this.controller = undefined
    }
  }
}
