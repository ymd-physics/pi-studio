// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionView } from './SessionView'
import type { Snapshot } from '../../../../packages/shared/desktop'

vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }))
afterEach(() => {
  cleanup()
  delete (window as any).desktop
})

it('closes the real lightbox without aborting a busy session, but still stops on a subsequent Escape', async () => {
  const initial: Snapshot = {
    handle: 'images',
    workspace: '/fixture',
    state: { sessionFile: '/fixture.jsonl', isStreaming: true },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect this image' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      ],
    }],
    models: [],
    commands: [],
    levels: [],
  }
  const command = vi.fn(async () => ({ commands: [] }))
  const snapshot = vi.fn(async () => ({ ...initial, state: { ...initial.state, isStreaming: false } }))
  window.desktop = {
    command,
    snapshot,
    onEvent: () => () => {},
    imageThumbnail: vi.fn().mockResolvedValue({
      dataUrl: 'data:image/jpeg;base64,AAAA', width: 2, height: 1,
    }),
  } as any
  render(<SessionView
    initial={initial}
    visible
    preferences={{ workspaces: [], theme: 'light', enterToSend: true }}
    toggleSidebar={vi.fn()}
    toggleFiles={vi.fn()}
    filesOpen={false}
    navigate={vi.fn()}
    changed={vi.fn()}
    attention={vi.fn()}
  />)
  await waitFor(() => expect(window.desktop.imageThumbnail).toHaveBeenCalled())
  expect(screen.getByRole('button', { name: 'Stop generation' })).toBeTruthy()
  const callsBefore = [...command.mock.calls]
  const opener = screen.getByRole('button', { name: 'Open Image 1' })
  fireEvent.click(opener)
  const dialog = screen.getByRole('dialog', { name: 'Image: Image 1' })
  expect(dialog.parentElement).toBe(document.body)
  const close = screen.getByRole('button', { name: 'Close image' })
  expect(document.activeElement).toBe(close)
  expect(fireEvent.keyDown(close, { key: 'Tab' })).toBe(false)
  expect(document.activeElement).toBe(close)
  expect(fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })).toBe(false)
  expect(document.activeElement).toBe(close)

  // Bypass document listeners to exercise SessionView's window-level modal guard.
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.getByRole('dialog', { name: 'Image: Image 1' })).toBe(dialog)
  expect(command.mock.calls).toEqual(callsBefore)

  // Normal bubbling reaches ImageLightbox first and must not reach the stop handler.
  expect(fireEvent.keyDown(close, { key: 'Escape' })).toBe(false)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(opener)
  expect(screen.getByRole('button', { name: 'Stop generation' })).toBeTruthy()
  expect(command.mock.calls).toEqual(callsBefore)
  expect(snapshot).not.toHaveBeenCalled()

  fireEvent.keyDown(opener, { key: 'Escape' })
  await waitFor(() => expect(command).toHaveBeenCalledWith('abort', undefined, 'images'))
  expect(command).toHaveBeenCalledWith('clear_queue', undefined, 'images')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop generation' })).toBeNull())
})
