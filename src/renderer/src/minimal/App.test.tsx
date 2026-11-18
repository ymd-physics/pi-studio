// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from './App'

vi.mock('./Conversation', () => ({ Conversation: () => null }))
vi.mock('./Files', () => ({ Files: () => null }))
vi.mock('./TerminalView', () => ({ TerminalView: (props: any) => <section hidden={!props.visible} aria-label={`Terminal ${props.info.name}`}>
  <button onClick={() => props.onFontSizeChange(16)}>Increase test terminal font</button>
</section> }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('submits a slash command only once while native discovery is delayed', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const commands = [{ name: 'perm', source: 'extension', description: 'Permission profile' }]
  const snapshot = {
    handle: 'session-a',
    workspace: '/test',
    state: { sessionFile: '/test/session.jsonl' },
    messages: [],
    commands,
    models: [],
    levels: [],
  }
  const pending: (() => void)[] = []
  const command = vi.fn(async (type: string) => {
    if (type === 'get_commands') return new Promise((resolve) => pending.push(() => resolve({ commands })))
    if (type === 'prompt') return { disposition: 'handled' }
    return {}
  })
  window.desktop = {
    boot: vi.fn(async () => ({
      runtime: 'Test Pi',
      preferences: {
        workspaces: [{ path: '/test', name: 'Test' }],
        activeWorkspace: '/test',
        activeSession: '/test/session.jsonl',
        theme: 'light',
        enterToSend: true,
      },
    })),
    onEvent: () => () => {},
    sessions: vi.fn(async () => []),
    runningSessions: vi.fn(async () => []),
    codexUsage: vi.fn(async () => ({ state: 'unavailable', reason: 'no-subscription', windows: [] })),
    terminals: vi.fn(async () => []),
    open: vi.fn(async () => snapshot),
    snapshot: vi.fn(async () => snapshot),
    documentDirty: vi.fn(async () => {}),
    command,
  } as any
  render(<App />)
  const input = await screen.findByRole('textbox', { name: 'Message Pi' })
  const workspace = screen.getByRole('button', { name: 'Test' })
  const opens = (window.desktop.open as any).mock.calls.length
  fireEvent.click(workspace)
  expect(workspace.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(workspace)
  expect(workspace.getAttribute('aria-expanded')).toBe('true')
  expect((window.desktop.open as any).mock.calls.length).toBe(opens)
  fireEvent.change(input, { target: { value: '/perm workspace' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect((input as HTMLTextAreaElement).disabled).toBe(true)
  expect(command.mock.calls.filter(([type]) => type === 'prompt')).toHaveLength(0)
  await act(async () => {
    pending.splice(0).forEach((resolve) => resolve())
  })
  await waitFor(() => expect(command.mock.calls.filter(([type]) => type === 'prompt')).toHaveLength(1))
  expect(command).toHaveBeenCalledWith('prompt', { message: '/perm workspace' }, 'session-a')
  await act(async () => {
    pending.splice(0).forEach((resolve) => resolve())
  })
})

function setupSidebar(workspaces = [{ path: '/first', name: 'First' }, { path: '/second', name: 'Second' }]) {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  let sequence = 0
  const open = vi.fn(async (workspace: string) => ({
    handle: `new-${++sequence}`, workspace,
    state: { sessionFile: `${workspace}/${sequence}.jsonl` },
    messages: [], commands: [], models: [], levels: [],
  }))
  window.desktop = {
    boot: vi.fn(async () => ({
      runtime: 'Test Pi',
      preferences: { workspaces, theme: 'light', enterToSend: true },
    })),
    onEvent: () => () => {},
    sessions: vi.fn(async () => []),
    runningSessions: vi.fn(async () => []),
    codexUsage: vi.fn(async () => ({ state: 'unavailable', reason: 'no-subscription', windows: [] })),
    documentDirty: vi.fn(async () => {}),
    command: vi.fn(async () => ({})),
    terminals: vi.fn(async () => []),
    open,
  } as any
  return open
}

it.each(['metaKey', 'ctrlKey'])('keeps scoped creation and %s+N without a full-width sidebar button', async (modifier) => {
  const open = setupSidebar()
  const view = render(<App />)
  await screen.findByRole('button', { name: 'New session in First' })
  const sidebar = within(view.container.querySelector('.sidebar') as HTMLElement)
  expect(sidebar.queryByRole('button', { name: /^New conversation/ })).toBeNull()
  expect(sidebar.getByRole('heading', { name: 'Workspaces', level: 2 })).toBeTruthy()
  expect(sidebar.getByRole('button', { name: 'Add workspace' })).toBeTruthy()
  // The empty-page guide remains, and the shortcut works before any session is open.
  expect(screen.getByRole('button', { name: 'New conversation' })).toBeTruthy()
  expect(open).not.toHaveBeenCalled()
  fireEvent.keyDown(window, { key: 'n', [modifier]: true })
  await screen.findByRole('textbox', { name: 'Message Pi' })
  expect(open).toHaveBeenCalledWith('/first', undefined)
  await waitFor(() => expect((sidebar.getByRole('button', { name: 'New session in Second' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(sidebar.getByRole('button', { name: 'New session in Second' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'New conversation' }))
  await waitFor(() => expect(open).toHaveBeenCalledWith('/second', undefined))
  await waitFor(() => expect((sidebar.getByRole('button', { name: 'New session in Second' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.keyDown(window, { key: 'n', [modifier]: true })
  await waitFor(() => expect(open).toHaveBeenCalledTimes(3))
  expect(open).toHaveBeenLastCalledWith('/second', undefined)
})

it('keeps first-use workspace guidance without creating an unscoped session', async () => {
  const open = setupSidebar([])
  render(<App />)
  const add = await screen.findByRole('button', { name: 'Add a workspace' })
  await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false))
  expect(screen.queryByRole('button', { name: 'New conversation' })).toBeNull()
  fireEvent.keyDown(window, { key: 'n', metaKey: true })
  expect(open).not.toHaveBeenCalled()
})

it('creates, renames, clears and closes a temporary terminal independently of AI sessions', async () => {
  const open = setupSidebar()
  let terminals: any[] = []
  const createTerminal = vi.fn(async (workspace) => {
    const info = { id: 'terminal-one', name: 'Terminal', workspace, cwd: workspace, shell: '/bin/zsh', state: 'ready', mode: 'command' }
    terminals.push(info)
    return info
  })
  const renameTerminal = vi.fn(async (id, name) => { terminals = terminals.map((info) => info.id === id ? { ...info, name } : info) })
  const closeTerminal = vi.fn(async () => { terminals = []; return true })
  Object.assign(window.desktop, {
    terminals: vi.fn(async () => terminals), createTerminal, renameTerminal, closeTerminal,
    preferences: vi.fn(async () => ({ workspaces: [{ path: '/first', name: 'First' }, { path: '/second', name: 'Second' }], theme: 'light', enterToSend: true, terminalFontSize: 16 })),
  })
  const original = HTMLDialogElement.prototype.showModal
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  try {
    render(<App />)
    const plus = await screen.findByRole('button', { name: 'New session in Second' })
    await waitFor(() => expect((plus as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(plus)
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'New terminal' }))
    await screen.findByRole('region', { name: 'Terminal Terminal' })
    expect(createTerminal).toHaveBeenCalledWith('/second')
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Increase test terminal font' }))
    await waitFor(() => expect(window.desktop.preferences).toHaveBeenCalledWith({ terminalFontSize: 16 }))
    const row = document.querySelector('.terminal-link')!
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear output' }))
    expect(closeTerminal).not.toHaveBeenCalled()
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Terminal name' }), { target: { value: 'Experiment' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(renameTerminal).toHaveBeenCalledWith('terminal-one', 'Experiment'))
    await screen.findByRole('region', { name: 'Terminal Experiment' })
    fireEvent.contextMenu(document.querySelector('.terminal-link')!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close terminal…' }))
    await waitFor(() => expect(document.querySelector('.terminal-link')).toBeNull())
    expect(closeTerminal).toHaveBeenCalledWith('terminal-one')
    expect(open).not.toHaveBeenCalled()
  } finally { HTMLDialogElement.prototype.showModal = original }
})
