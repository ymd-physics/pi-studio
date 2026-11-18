// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { Markdown } from './Markdown'
afterEach(cleanup)
const dataUrl = 'data:image/png;base64,AA=='
it('renders local/file links and images; local clicks stay bound to their origin and never bubble to HTTP handling', async () => {
  const openLocalLink = vi.fn().mockResolvedValue(undefined), bubbled = vi.fn()
  const previewLocalImage = vi.fn().mockResolvedValue({ dataUrl })
  window.desktop = { openLocalLink, previewLocalImage } as any
  const { container } = render(<div onClick={bubbled}><Markdown origin={{ handle: 'session-A', baseDir: 'plots' }} text={'[PDF](file:///tmp/report.pdf)\n\n[![plot](figure.png)](report.pdf)'} /></div>)
  await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(dataUrl))
  expect(previewLocalImage).toHaveBeenCalledWith('session-A', 'figure.png', 'plots', false)
  expect(container.querySelector('a a')).toBeNull()
  fireEvent.click(screen.getByRole('link', { name: 'PDF' }))
  expect(openLocalLink).toHaveBeenCalledExactlyOnceWith('session-A', 'file:///tmp/report.pdf', 'plots')
  expect(bubbled).not.toHaveBeenCalled()
})
it('does not apply a stale image from another session and requires explicit outside-image approval', async () => {
  let resolveFirst!: (value: any) => void
  const previewLocalImage = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
    .mockResolvedValueOnce({ needsApproval: true }).mockResolvedValue({ dataUrl })
  window.desktop = { previewLocalImage } as any
  const view = render(<Markdown origin={{ handle: 'A' }} text={'![chart](chart.png)'} />)
  await waitFor(() => expect(previewLocalImage).toHaveBeenCalledTimes(1))
  view.rerender(<Markdown origin={{ handle: 'B' }} text={'![chart](chart.png)'} />)
  await screen.findByRole('button', { name: 'Load image outside workspace' })
  await act(async () => resolveFirst({ dataUrl: 'data:image/png;base64,OLD' }))
  expect(view.container.querySelector('img')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Load image outside workspace' }))
  await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe(dataUrl))
  expect(previewLocalImage).toHaveBeenLastCalledWith('B', 'chart.png', undefined, true)
})
