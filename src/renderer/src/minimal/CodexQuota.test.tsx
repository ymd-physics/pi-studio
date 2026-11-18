// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexQuota } from './CodexQuota'
import type { CodexUsageSnapshot } from '../../../../packages/shared/codex-usage'

const now = Date.UTC(2026, 0, 1)
function usage(overrides: Partial<CodexUsageSnapshot> = {}): CodexUsageSnapshot {
  return {
    provider: 'openai-codex', state: 'ready', reason: null, stale: false, capturedAt: now,
    windows: [{ durationSeconds: 18000, remainingPercent: 42.4, resetsAt: now / 1000 + 3660 }],
    ...overrides,
  }
}
afterEach(() => { cleanup(); vi.useRealTimers() })

it('counts down real reset timestamps every minute and cleans up its timer', () => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  const view = render(<CodexQuota usage={usage()} />)
  expect(screen.getByText('Resets in 1h 1m')).toBeTruthy()
  expect(screen.getByText('42% left').parentElement?.title).toContain(new Date(now + 3660000).toLocaleString())
  expect(screen.queryByText('1 min')).toBeNull()
  act(() => vi.advanceTimersByTime(60000))
  expect(screen.getByText('Resets in 1h')).toBeTruthy()
  act(() => vi.advanceTimersByTime(3600000))
  expect(screen.getByText('Reset due · awaiting update')).toBeTruthy()
  expect(screen.getByText('42% left')).toBeTruthy()
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not invent a reset time and distinguishes stale data from unavailable data', () => {
  const view = render(<CodexQuota usage={usage({ windows: [{ durationSeconds: 604800, remainingPercent: 20, resetsAt: null }] })} />)
  expect(screen.getByText('Reset time unavailable')).toBeTruthy()
  expect(screen.getByText('Week')).toBeTruthy()
  expect(screen.getByText('20% left').parentElement?.title).not.toContain('Resets')
  view.rerender(<CodexQuota usage={usage({ stale: true })} />)
  expect(screen.getByText('Update delayed')).toBeTruthy()
  view.rerender(<CodexQuota usage={usage({ state: 'error', reason: 'timeout', windows: [] })} />)
  expect(screen.getByText('Quota unavailable').title).toContain('timed out')
})

it('formats weekly reset time and renders nothing without an eligible subscription', () => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  const view = render(<CodexQuota usage={usage({ windows: [{ durationSeconds: 604800, remainingPercent: 90, resetsAt: now / 1000 + 176400 }] })} />)
  expect(screen.getByText('Resets in 2d 1h')).toBeTruthy()
  for (const reason of ['not-started', 'stopped', 'no-subscription', 'account-changed'] as const) {
    view.rerender(<CodexQuota usage={usage({ reason, windows: [] })} />)
    expect(view.container.innerHTML).toBe('')
  }
  view.rerender(<CodexQuota />)
  expect(view.container.innerHTML).toBe('')
})
