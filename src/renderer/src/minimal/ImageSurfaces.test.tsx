// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UserAttachments } from './ImageSurfaces'

const image = { key: 'one', name: 'sample.png', index: 0, total: 1,
  block: { type: 'image', mimeType: 'image/png', data: 'AAAA' } }
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (window as any).desktop
})

it('requests physical frame pixels, resizes with the card, and ignores hidden frames', async () => {
  vi.stubGlobal('devicePixelRatio', 2)
  let width = 128, height = 78
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)
  let resized!: () => void
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback }
    observe() {}
    disconnect = disconnect
  })
  const imageThumbnail = vi.fn().mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,AAAA', width: 832, height: 96 })
  window.desktop = { imageThumbnail } as any
  const view = render(<UserAttachments images={[image]} files={[]} onOpen={vi.fn()} />)
  await waitFor(() => expect(imageThumbnail).toHaveBeenCalledTimes(1))
  expect(imageThumbnail).toHaveBeenLastCalledWith('AAAA', 'image/png', { width: 256, height: 156 })
  width = 116; height = 70
  act(() => resized())
  await waitFor(() => expect(imageThumbnail).toHaveBeenCalledTimes(2))
  expect(imageThumbnail).toHaveBeenLastCalledWith('AAAA', 'image/png', { width: 232, height: 140 })
  act(() => resized())
  expect(imageThumbnail).toHaveBeenCalledTimes(2)
  width = 0; height = 0
  fireEvent.resize(window)
  act(() => resized())
  expect(imageThumbnail).toHaveBeenCalledTimes(2)
  width = 128; height = 78
  vi.stubGlobal('devicePixelRatio', 3)
  fireEvent.resize(window)
  await waitFor(() => expect(imageThumbnail).toHaveBeenCalledTimes(3))
  expect(imageThumbnail).toHaveBeenLastCalledWith('AAAA', 'image/png', { width: 384, height: 234 })
  view.unmount()
  expect(disconnect).toHaveBeenCalled()
  fireEvent.resize(window)
  expect(imageThumbnail).toHaveBeenCalledTimes(3)
})

it('reattaches sizing observation when an unavailable card replaces the button', async () => {
  vi.stubGlobal('devicePixelRatio', 2)
  let width = 128, height = 78
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)
  const callbacks = new Map<Element, () => void>()
  vi.stubGlobal('ResizeObserver', class {
    target?: Element
    constructor(private callback: () => void) {}
    observe(element: Element) { this.target = element; callbacks.set(element, this.callback) }
    disconnect() { if (this.target) callbacks.delete(this.target) }
  })
  const imageThumbnail = vi.fn().mockResolvedValueOnce(null).mockResolvedValue({
    dataUrl: 'data:image/jpeg;base64,AAAA', width: 832, height: 96,
  })
  window.desktop = { imageThumbnail } as any
  const view = render(<UserAttachments images={[image]} files={[]} onOpen={vi.fn()} />)
  const original = view.container.querySelector('.image-frame')!
  await view.findByText('Preview unavailable')
  const replacement = view.container.querySelector('.image-frame')!
  expect(replacement).not.toBe(original)
  expect(callbacks.has(original)).toBe(false)
  expect(callbacks.has(replacement)).toBe(true)
  width = 116; height = 70
  await act(async () => callbacks.get(replacement)!())
  await view.findByRole('button', { name: 'Open sample.png' })
  expect(imageThumbnail).toHaveBeenCalledTimes(2)
  expect(imageThumbnail).toHaveBeenLastCalledWith('AAAA', 'image/png', { width: 232, height: 140 })
  expect(callbacks.has(view.container.querySelector('.image-frame')!)).toBe(true)
  view.unmount()
  expect(callbacks.size).toBe(0)
})

it('does not open the original while thumbnail validation is still pending', async () => {
  let finish!: (value: unknown) => void
  const onOpen = vi.fn()
  window.desktop = { imageThumbnail: vi.fn(() => new Promise((resolve) => { finish = resolve })) } as any
  const view = render(<UserAttachments images={[image]} files={[]} onOpen={onOpen} />)
  const opener = view.getByRole('button', { name: 'Open sample.png' }) as HTMLButtonElement
  expect(opener.disabled).toBe(true)
  fireEvent.click(opener)
  expect(onOpen).not.toHaveBeenCalled()
  await act(async () => finish({ dataUrl: 'data:image/jpeg;base64,AAAA', width: 832, height: 96 }))
  expect(opener.disabled).toBe(false)
  fireEvent.click(opener)
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ src: 'data:image/png;base64,AAAA' }))
})

it('does not request a thumbnail until the image approaches the viewport', async () => {
  let intersected!: (entries: { isIntersecting: boolean }[]) => void
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersected) { intersected = callback }
    observe() {}
    disconnect() {}
  })
  const imageThumbnail = vi.fn().mockResolvedValue(null)
  window.desktop = { imageThumbnail } as any
  render(<UserAttachments images={[image]} files={[]} onOpen={vi.fn()} />)
  expect(imageThumbnail).not.toHaveBeenCalled()
  await act(async () => intersected([{ isIntersecting: true }]))
  expect(imageThumbnail).toHaveBeenCalledTimes(1)
})
