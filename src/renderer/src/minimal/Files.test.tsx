// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Files } from './Files'
vi.mock('./Markdown', () => ({ CodeBlock: () => null, Markdown: () => null }))
afterEach(cleanup)
it('starts a terminal in the selected folder or the parent of the selected file', async () => {
  const openTerminal = vi.fn(async () => {})
  window.desktop = { files: async (directory: string) => directory ? [{ name:'notes.md', path:'docs/notes.md', isDirectory:false }] : [{ name:'docs', path:'docs', isDirectory:true }] } as unknown as typeof window.desktop
  render(<Files close={() => {}} onDirty={() => {}} openTerminal={openTerminal} />)
  const folder = await screen.findByRole('button', {name:'docs'})
  fireEvent.contextMenu(folder)
  fireEvent.click(screen.getByRole('menuitem', {name:'New terminal here'}))
  fireEvent.click(folder)
  fireEvent.contextMenu(await screen.findByRole('button', {name:'notes.md'}))
  fireEvent.click(screen.getByRole('menuitem', {name:'New terminal in containing folder'}))
  fireEvent.contextMenu(screen.getByRole('button', {name:'notes.md'}).parentElement!)
  fireEvent.click(screen.getByRole('menuitem', {name:'New terminal here'}))
  expect(openTerminal.mock.calls).toEqual([['docs'], ['docs'], ['docs']])
})
it('opens the current directory or the containing folder without launching the selected file', async () => {
  const openFileExternally = vi.fn(async () => {})
  window.desktop = { openFileExternally, files: async (dir: string) => dir ? [{name:'report.pdf',path:'docs/report.pdf',isDirectory:false}] : [{name:'docs',path:'docs',isDirectory:true}] } as unknown as typeof window.desktop
  render(<Files handle="A" close={() => {}} onDirty={() => {}} />)
  const folder = await screen.findByRole('button', {name:'docs'})
  await act(async () => fireEvent.click(screen.getByRole('button',{name:/Open in Finder|Open folder externally/})))
  fireEvent.click(folder)
  const file = await screen.findByRole('button',{name:'report.pdf'})
  fireEvent.contextMenu(file)
  await act(async () => fireEvent.click(screen.getByRole('menuitem',{name:/Open containing folder/})))
  expect(openFileExternally.mock.calls).toEqual([['A',''],['A','docs']])
})
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
