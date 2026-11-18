// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ContextMeter } from './ContextMeter'
afterEach(cleanup)
it('shows native current-context counts and risk without confusing cumulative usage', () => {
  const view = render(<ContextMeter usage={{ tokens: 100000, contextWindow: 200000, percent: 50 }} />)
  expect(screen.getByText('100k / 200k')).toBeTruthy()
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
  view.rerender(<ContextMeter usage={{ tokens: 190000, contextWindow: 200000, percent: 95 }} />)
  expect(view.container.querySelector('.critical')).toBeTruthy()
})
it('does not invent zero usage after compaction or with unavailable estimates', () => {
  render(<ContextMeter usage={{ tokens: null, contextWindow: 200000, percent: null }} />)
  expect(screen.getByText('— / 200k')).toBeTruthy()
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
})
