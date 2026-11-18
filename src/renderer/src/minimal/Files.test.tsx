// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Files } from './Files'
vi.mock('./Markdown', () => ({ CodeBlock: () => null, Markdown: () => null }))
afterEach(cleanup)
it('ignores a stale file read after a newer selection has been edited', async () => {
  const deferred: Record<string, (data: { content: string; revision: string }) => void> = {}
  window.desktop = {
    files: vi.fn(async () => ['A', 'B'].map((name) => ({ name, path: name, isDirectory: false }))),
    readFile: vi.fn(
      (path) =>
        new Promise((resolve) => {
          deferred[path] = resolve
        }),
    ),
  } as unknown as typeof window.desktop
  render(<Files close={() => {}} onDirty={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'A' }))
  fireEvent.click(screen.getByRole('button', { name: 'B' }))
  await act(async () => deferred.B({ content: 'B original', revision: 'B' }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'File editor' }), { target: { value: 'B draft' } })
  await act(async () => deferred.A({ content: 'A original', revision: 'A' }))
  expect((screen.getByRole('textbox', { name: 'File editor' }) as HTMLTextAreaElement).value).toBe('B draft')
})
