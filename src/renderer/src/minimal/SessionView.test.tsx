// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionView } from './SessionView'
import type { PiRecord, Snapshot } from '../../../../packages/shared/desktop'
vi.mock('./Conversation', () => ({
  Conversation: ({ messages }: any) => <div>{JSON.stringify(messages)}</div>,
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const make = (handle: string): Snapshot => ({
  handle,
  workspace: `/${handle}`,
  state: { sessionFile: `/${handle}.jsonl` },
  messages: [],
  models: [],
  commands: [],
  levels: [],
})
const preferences = { workspaces: [], theme: 'light' as const, enterToSend: true }
it('keeps the files icon and toggle behavior in the top-right button', () => {
  window.desktop = { onEvent: () => () => {} } as any
  const props = {
    initial: make('A'),
    visible: true,
    preferences,
    toggleSidebar: vi.fn(),
    toggleFiles: vi.fn(),
    filesOpen: false,
    navigate: vi.fn(),
    changed: vi.fn(),
    attention: vi.fn(),
  }
  const view = render(<SessionView {...props} />)
  const button = screen.getByRole('button', { name: 'Toggle files' })
  expect(button.querySelector('svg.lucide-files')).not.toBeNull()
  expect(button.title).toBe('Open files')
  fireEvent.click(button)
  expect(props.toggleFiles).toHaveBeenCalledTimes(1)
  view.rerender(<SessionView {...props} filesOpen />)
  expect(button.title).toBe('Close files')
  expect(button.classList.contains('active')).toBe(true)
})
it('clears handled-command busy state even when a custom message arrives during snapshot refresh', async () => {
  let listener!: (event: PiRecord) => void
  let resolveSnapshot!: (value: Snapshot) => void
  const initial = make('A')
  initial.commands = [{ name: 'notice', source: 'extension', description: 'Fixture' }]
  const command = vi.fn(async (type) => type === 'get_commands' ? { commands: initial.commands } : { disposition: 'handled' })
  window.desktop = { command, onEvent: (fn: any) => { listener = fn; return () => {} },
    snapshot: vi.fn(() => new Promise(resolve => { resolveSnapshot = resolve })) } as any
  render(<SessionView initial={initial} visible preferences={preferences} toggleSidebar={vi.fn()} toggleFiles={vi.fn()} filesOpen={false} navigate={vi.fn()} changed={vi.fn()} attention={vi.fn()} />)
  const input = screen.getByRole('textbox', { name: 'Message Pi' })
  fireEvent.change(input, { target: { value: '/notice' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(resolveSnapshot).toBeTypeOf('function'))
  await act(async () => {
    listener({ type: 'message_end', desktopSession: 'A', message: { role: 'custom', content: 'Notice', timestamp: 1 } })
    resolveSnapshot(initial)
  })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull())
  fireEvent.change(input, { target: { value: 'next prompt' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(command).toHaveBeenCalledWith('prompt', { message: 'next prompt' }, 'A'))
  expect(command.mock.calls.some(([type]) => type === 'steer')).toBe(false)
})
it('preserves the next draft when an in-flight send fails', async () => {
  let reject!: (error: Error) => void
  window.desktop = {
    onEvent: () => () => {},
    command: vi.fn((type) =>
      type === 'prompt'
        ? new Promise((_resolve, fail) => {
            reject = fail
          })
        : Promise.resolve({}),
    ),
  } as any
  render(
    <SessionView
      initial={make('A')}
      visible
      preferences={preferences}
      toggleSidebar={vi.fn()}
      toggleFiles={vi.fn()}
      filesOpen={false}
      navigate={vi.fn()}
      changed={vi.fn()}
      attention={vi.fn()}
    />,
  )
  const input = screen.getByRole('textbox', { name: 'Message Pi' })
  fireEvent.change(input, { target: { value: 'first message' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.change(input, { target: { value: 'next draft' } })
  await act(async () => reject(new Error('Request failed')))
  expect((input as HTMLTextAreaElement).value).toBe('first message\n\nnext draft')
})
it('keeps drafts and permission answers bound to background sessions', async () => {
  const listeners = new Set<(event: PiRecord) => void>()
  const respond = vi.fn(async () => {})
  const command = vi.fn(async () => ({ commands: [] }))
  window.desktop = {
    command,
    respond,
    onEvent: (fn: any) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  } as any
  const common = {
    preferences,
    toggleSidebar: vi.fn(),
    toggleFiles: vi.fn(),
    filesOpen: false,
    navigate: vi.fn(),
    changed: vi.fn(),
    attention: vi.fn(),
  }
  const a = make('A'),
    b = make('B')
  const views = (selected: string) => (
    <>
      <SessionView {...common} initial={a} visible={selected === 'A'} />
      <SessionView {...common} initial={b} visible={selected === 'B'} />
    </>
  )
  const view = render(views('A'))
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Pi' }), { target: { value: 'draft A' } })
  view.rerender(views('B'))
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Pi' }), { target: { value: 'draft B' } })
  act(() =>
    listeners.forEach((fn) =>
      fn({
        type: 'extension_ui_request',
        desktopSession: 'A',
        id: 'same-id',
        method: 'confirm',
        title: 'Allow A?',
      }),
    ),
  )
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(common.attention).toHaveBeenCalledWith('A', 1)
  act(() =>
    listeners.forEach((fn) =>
      fn({
        type: 'extension_ui_request',
        desktopSession: 'A',
        id: 'second-id',
        method: 'confirm',
        title: 'Allow second A?',
      }),
    ),
  )
  expect(common.attention).toHaveBeenLastCalledWith('A', 2)
  view.rerender(views('A'))
  expect((screen.getByRole('textbox', { name: 'Message Pi' }) as HTMLTextAreaElement).value).toBe('draft A')
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  expect(respond).toHaveBeenCalledWith({
    type: 'extension_ui_response',
    desktopSession: 'A',
    id: 'same-id',
    confirmed: true,
  })
  await waitFor(() => expect(common.attention).toHaveBeenLastCalledWith('A', 1))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  await waitFor(() => expect(common.attention).toHaveBeenLastCalledWith('A', 0))
  view.rerender(views('B'))
  expect((screen.getByRole('textbox', { name: 'Message Pi' }) as HTMLTextAreaElement).value).toBe('draft B')
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message Pi' }), { key: 'Enter' })
  await waitFor(() => expect(command).toHaveBeenCalledWith('prompt', { message: 'draft B' }, 'B'))
})
it('routes delayed discovery submission to its original handle after switching away', async () => {
  let finish!: (data: any) => void
  const command = vi.fn(async (type: string) =>
    type === 'get_commands'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : {},
  )
  window.desktop = { command, onEvent: () => () => {} } as any
  const props = {
    initial: make('A'),
    visible: true,
    preferences,
    toggleSidebar: vi.fn(),
    toggleFiles: vi.fn(),
    filesOpen: false,
    navigate: vi.fn(),
    changed: vi.fn(),
    attention: vi.fn(),
  }
  const view = render(<SessionView {...props} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '/custom x' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  view.rerender(<SessionView {...props} visible={false} />)
  await act(async () => finish({ commands: [{ name: 'custom', source: 'extension' }] }))
  expect(command).toHaveBeenCalledWith('prompt', { message: '/custom x' }, 'A')
})
