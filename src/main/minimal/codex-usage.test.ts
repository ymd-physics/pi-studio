import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexUsageService, normalizeCodexUsage, type CodexUsageRuntime } from './codex-usage'

const payload = {
  rate_limit: {
    primary_window: { limit_window_seconds: '604800', used_percent: '20', reset_at: '2000000000' },
    secondary_window: { limit_window_seconds: 18000, used_percent: 110 },
  },
}
function fixture() {
  let token = 'mock-credential-one'
  const runtime: CodexUsageRuntime = {
    getProvider: vi.fn(() => ({
      baseUrl: 'https://chatgpt.com/backend-api',
      auth: { oauth: { isSubscription: true } },
    })),
    checkAuth: vi.fn(async () => ({ type: 'oauth' })),
    getAuth: vi.fn(async () => ({ source: 'OAuth', auth: { apiKey: token } })),
  }
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload)))
  const changed = vi.fn()
  const service = new CodexUsageService({ loadRuntime: async () => runtime, fetch: fetcher, changed })
  return {
    runtime,
    fetcher,
    service,
    changed,
    setToken: (value: string) => {
      token = value
    },
  }
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}
afterEach(() => {
  vi.useRealTimers()
})

describe('CodexUsageService', () => {
  it('does no runtime or auth work before demand', async () => {
    const loadRuntime = vi.fn()
    const service = new CodexUsageService({ loadRuntime })
    expect(service.snapshot().reason).toBe('not-started')
    expect(loadRuntime).not.toHaveBeenCalled()
  })
  it('resumes immediately despite late runtime and fetch from older generations', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let releaseRuntime!: (runtime: CodexUsageRuntime) => void
    let releaseFetch!: (response: Response) => void
    const loadRuntime = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseRuntime = resolve }))
      .mockResolvedValue(f.runtime)
    f.fetcher.mockImplementationOnce(() => new Promise((resolve) => { releaseFetch = resolve }))
    const service = new CodexUsageService({ loadRuntime, fetch: f.fetcher })
    service.start()
    service.stop()
    service.start()
    await flush()
    expect(f.fetcher).toHaveBeenCalledTimes(1)
    releaseRuntime(f.runtime)
    await flush()
    service.stop()
    service.start()
    await flush()
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(service.snapshot().state).toBe('ready')
    const late = new Response(JSON.stringify(payload))
    const cancel = vi.spyOn(late.body!, 'cancel')
    releaseFetch(late)
    await flush()
    expect(cancel).toHaveBeenCalled()
    expect(service.snapshot().state).toBe('ready')
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.fetcher).toHaveBeenCalledTimes(3)
    service.stop()
  })
  it('does not let late credential resolution displace a resumed poll', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let release!: (value: any) => void
    vi.mocked(f.runtime.getAuth).mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    f.service.start()
    await flush()
    f.service.stop()
    f.service.start()
    await flush()
    expect(f.fetcher).toHaveBeenCalledTimes(1)
    expect(f.service.snapshot().state).toBe('ready')
    release({ source: 'OAuth', auth: { apiKey: 'mock-old' } })
    await flush()
    expect(f.fetcher).toHaveBeenCalledTimes(1)
    expect(f.service.snapshot().state).toBe('ready')
    f.service.stop()
  })
  it('normalizes duration not position, numeric strings, clamps and leaves missing values absent', () => {
    expect(normalizeCodexUsage(payload)).toEqual([
      { durationSeconds: 18000, remainingPercent: 0, resetsAt: null },
      { durationSeconds: 604800, remainingPercent: 80, resetsAt: 2000000000 },
    ])
    for (const used_percent of [null, '', 'bad', true, Infinity])
      expect(() =>
        normalizeCodexUsage({
          rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent } },
        }),
      ).toThrow()
    expect(() => normalizeCodexUsage(null)).toThrow()
  })
  it('polls immediately and each minute, is idempotent and only publishes safe clones', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.service.start()
    f.service.start()
    await flush()
    expect(f.fetcher).toHaveBeenCalledTimes(1)
    expect(f.fetcher.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(f.fetcher.mock.calls[0][1]?.redirect).toBe('error')
    expect(f.service.snapshot().state).toBe('ready')
    expect(JSON.stringify(f.changed.mock.calls)).not.toContain('mock-credential')
    f.service.snapshot().windows.length = 0
    expect(f.service.snapshot().windows).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    f.service.stop()
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.fetcher).toHaveBeenCalledTimes(2)
  })
  it.each([401, 429, 500])('handles HTTP %s without server text or false zeros', async (status) => {
    vi.useFakeTimers()
    const f = fixture()
    f.service.start()
    await flush()
    f.fetcher.mockImplementation(async () => new Response('secret server text', { status }))
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.service.snapshot().reason).toBe(
      status === 401 ? 'unauthorized' : status === 429 ? 'rate-limited' : 'request-failed',
    )
    expect(f.service.snapshot().windows.length).toBe(status === 401 ? 0 : 2)
    expect(f.service.snapshot().stale).toBe(status !== 401)
    expect(JSON.stringify(f.service.snapshot())).not.toContain('secret')
    f.service.stop()
  })
  it.each(['{}', 'bad json', 'x'.repeat(65537)])('rejects invalid/bounded bodies', async (body) => {
    vi.useFakeTimers()
    const f = fixture()
    f.fetcher.mockImplementation(async () => new Response(body))
    f.service.start()
    await flush()
    expect(f.service.snapshot().reason).toBe('invalid-response')
    expect(f.service.snapshot().windows).toEqual([])
    f.service.stop()
  })
  it('never resolves or sends modern subscription/API-key auth to wham', async () => {
    vi.useFakeTimers()
    const f = fixture()
    vi.mocked(f.runtime.checkAuth).mockImplementation(async (id) => ({
      type: id === 'openai' ? 'oauth' : 'api_key',
    }))
    f.service.start()
    await flush()
    expect(f.service.snapshot().reason).toBe('unsupported-subscription')
    expect(f.runtime.getAuth).not.toHaveBeenCalled()
    expect(f.fetcher).not.toHaveBeenCalled()
    vi.mocked(f.runtime.checkAuth).mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.service.snapshot().reason).toBe('no-subscription')
    f.service.stop()
  })
  it.each([
    'https://proxy.test/backend-api',
    'https://chatgpt.com.evil.test/backend-api',
    'http://chatgpt.com/backend-api',
    'https://user@chatgpt.com/backend-api',
  ])('rejects provider origin %s', async (baseUrl) => {
    vi.useFakeTimers()
    const f = fixture()
    vi.mocked(f.runtime.getProvider).mockReturnValue({ baseUrl, auth: { oauth: { isSubscription: true } } })
    f.service.start()
    await flush()
    expect(f.service.snapshot().reason).toBe('untrusted-origin')
    expect(f.runtime.getAuth).not.toHaveBeenCalled()
    expect(f.fetcher).not.toHaveBeenCalled()
    f.service.stop()
  })
  it('rejects resolved origin and API-key sources', async () => {
    vi.useFakeTimers()
    const f = fixture()
    vi.mocked(f.runtime.getAuth).mockResolvedValue({
      source: 'OAuth',
      auth: { apiKey: 'mock', baseUrl: 'https://proxy.test' },
    })
    f.service.start()
    await flush()
    expect(f.service.snapshot().reason).toBe('untrusted-origin')
    vi.mocked(f.runtime.getAuth).mockResolvedValue({ source: 'environment', auth: { apiKey: 'mock' } })
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.service.snapshot().reason).toBe('auth-unavailable')
    expect(f.fetcher).not.toHaveBeenCalled()
    f.service.stop()
  })
  it('discards responses if native credentials changed during request', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.fetcher.mockImplementation(async () => {
      f.setToken('mock-other-account')
      return new Response(JSON.stringify(payload))
    })
    f.service.start()
    await flush()
    expect(f.service.snapshot().reason).toBe('account-changed')
    expect(f.service.snapshot().windows).toEqual([])
    f.service.stop()
  })
  it('times out, cancels, remains single-flight and ignores late results after stop', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let resolve!: (response: Response) => void
    f.fetcher.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    f.service.start()
    await flush()
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.fetcher).toHaveBeenCalledTimes(1)
    expect(f.service.snapshot().reason).toBe('timeout')
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    f.service.stop()
    resolve(new Response(JSON.stringify(payload)))
    await flush()
    expect(f.service.snapshot().reason).toBe('stopped')
  })
  it('ignores late auth resolution after shutdown without making a request', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let resolve!: (runtime: CodexUsageRuntime) => void
    const service = new CodexUsageService({
      loadRuntime: () =>
        new Promise((done) => {
          resolve = done
        }),
      fetch: f.fetcher,
    })
    service.start()
    service.stop()
    resolve(f.runtime)
    await flush()
    expect(service.snapshot().reason).toBe('stopped')
    expect(f.fetcher).not.toHaveBeenCalled()
  })
  it('does not retain prior-account values if credentials change during a failed request', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.service.start()
    await flush()
    f.fetcher.mockImplementation(async () => {
      f.setToken('mock-switched-during-error')
      return new Response(null, { status: 429 })
    })
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.service.snapshot().windows).toEqual([])
    f.service.stop()
  })
  it('reports runtime/auth exceptions without exporting exception text', async () => {
    vi.useFakeTimers()
    const service = new CodexUsageService({
      loadRuntime: async () => {
        throw new Error('secret credential')
      },
    })
    service.start()
    await flush()
    expect(service.snapshot().reason).toBe('request-failed')
    expect(JSON.stringify(service.snapshot())).not.toContain('secret')
    service.stop()
  })
  it('clears prior-account stale values when next credential changes and request fails', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.service.start()
    await flush()
    f.setToken('mock-other-account')
    f.fetcher.mockRejectedValue(new Error('sensitive token error'))
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.service.snapshot().windows).toEqual([])
    expect(JSON.stringify(f.changed.mock.calls)).not.toContain('sensitive')
    f.service.stop()
  })
})
