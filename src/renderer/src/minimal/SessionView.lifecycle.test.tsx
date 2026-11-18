// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionView } from './SessionView'
import type { PiRecord, Snapshot } from '../../../../packages/shared/desktop'
vi.mock('./Conversation', () => ({ Conversation: () => null }))
afterEach(cleanup)
const initial: Snapshot = {
  handle: 'A',
  workspace: '/test',
  state: { sessionFile: '/A.jsonl' },
  messages: [],
  commands: [],
  models: [],
  levels: [],
}
const common = {
  initial,
  visible: true,
  preferences: { workspaces: [], theme: 'light' as const, enterToSend: true },
  toggleSidebar: vi.fn(),
  toggleFiles: vi.fn(),
  filesOpen: false,
  navigate: vi.fn(),
  changed: vi.fn(),
  attention: vi.fn(),
}
it('keeps a replacement-process permission dialog received before clone finishes', async () => {
  let emit!: (r: PiRecord) => void
  const request = {
    type: 'extension_ui_request',
    desktopSession: 'A',
    method: 'confirm',
    id: 'new-dialog',
    title: 'New session permission',
  }
  window.desktop = {
    onEvent: (fn: any) => {
      emit = fn
      return () => {}
    },
    command: vi.fn(async () => {
      emit(request)
      return {}
    }),
    snapshot: vi.fn(async () => ({
      ...initial,
      state: { sessionFile: '/clone.jsonl', isStreaming: true },
      ui: [request],
    })),
    respond: vi.fn(async () => {}),
  } as any
  render(<SessionView {...common} action={{ handle: 'A', name: 'clone', sequence: 1 }} />)
  await expect(screen.findByRole('dialog', { name: 'New session permission' })).resolves.toBeTruthy()
  await waitFor(() => expect(common.changed).toHaveBeenCalled())
  expect(screen.getByRole('dialog', { name: 'New session permission' })).toBeTruthy()
})
it('does not let an older snapshot erase a newly arrived request', async () => {
  let emit!: (r: PiRecord) => void
  let resolve!: (s: Snapshot) => void
  window.desktop = {
    onEvent: (fn: any) => {
      emit = fn
      return () => {}
    },
    command: vi.fn(async () => ({})),
    snapshot: vi.fn(
      async () =>
        new Promise((r) => {
          resolve = r
        }),
    ),
    respond: vi.fn(async () => {}),
  } as any
  render(<SessionView {...common} />)
  act(() => emit({ type: 'agent_settled', desktopSession: 'A' }))
  act(() =>
    emit({
      type: 'extension_ui_request',
      desktopSession: 'A',
      id: 'latest',
      method: 'confirm',
      title: 'Must survive',
    }),
  )
  expect(screen.getByRole('dialog', { name: 'Must survive' })).toBeTruthy()
  await act(async () => resolve({ ...initial, ui: [] }))
  expect(screen.getByRole('dialog', { name: 'Must survive' })).toBeTruthy()
})
it('does not discard a request arriving during reload discovery if reload is rejected', async () => {
  let emit!: (r: PiRecord) => void
  let resolve!: (r: any) => void
  window.desktop = {
    onEvent: (fn: any) => {
      emit = fn
      return () => {}
    },
    command: vi.fn(
      async () =>
        new Promise((r) => {
          resolve = r
        }),
    ),
    reload: vi.fn(async () => {
      throw new Error('Stop current operation')
    }),
    respond: vi.fn(async () => {}),
  } as any
  render(<SessionView {...common} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '/reload' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  await act(async () => {
    emit({
      type: 'extension_ui_request',
      desktopSession: 'A',
      id: 'pending',
      method: 'confirm',
      title: 'Still needed',
    })
    resolve({ commands: [] })
  })
  await waitFor(() => expect(window.desktop.reload).toHaveBeenCalledWith('A'))
  expect(screen.getByRole('dialog', { name: 'Still needed' })).toBeTruthy()
})
