// @vitest-environment jsdom
import { createRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Composer } from './Composer'
import type { Snapshot } from '../../../../packages/shared/desktop'
import type { CodexUsageSnapshot } from '../../../../packages/shared/codex-usage'

afterEach(cleanup)
function props() {
  return {
    session: {
      handle: 'test',
      workspace: '/test',
      state: {},
      messages: [],
      commands: [],
      models: [],
      levels: [],
    } as Snapshot,
    draft: 'Hello',
    setDraft: vi.fn(),
    inputRef: createRef<HTMLTextAreaElement>(),
    commands: [{ name: 'demo', description: 'Native extension', source: 'extension' }],
    busy: false,
    loading: false,
    enterToSend: true,
    widgets: {},
    statuses: {},
    send: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
  }
}
it('does not send Shift+Enter or an IME composition; respects configured Enter behavior', () => {
  const p = props()
  const view = render(<Composer {...p} />)
  const input = screen.getByRole('textbox')
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(p.send).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(p.send).toHaveBeenCalledTimes(1)
  view.rerender(<Composer {...p} enterToSend={false} />)
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(p.send).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
  expect(p.send).toHaveBeenCalledTimes(2)
})
it('completes discovered slash commands without prematurely sending', () => {
  const p = props()
  const view = render(<Composer {...p} draft="/de" />)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' })
  expect(p.setDraft).toHaveBeenLastCalledWith('/demo ')
  expect(p.send).not.toHaveBeenCalled()
  view.rerender(<Composer {...p} draft="/demo" />)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(p.send).toHaveBeenCalledTimes(1)
})
it('shows all commands, refreshes discovery, and preserves argument input', () => {
  const p = props()
  const refreshCommands = vi.fn()
  const commands = Array.from({ length: 20 }, (_, i) => ({
    name: `cmd${i}`,
    description: 'Native command',
    source: 'extension',
  }))
  const view = render(<Composer {...p} commands={commands} draft="/" refreshCommands={refreshCommands} />)
  expect(screen.getByRole('listbox').querySelectorAll('[role="option"]')).toHaveLength(20)
  expect(refreshCommands).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowUp' })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' })
  expect(p.setDraft).toHaveBeenLastCalledWith('/cmd19 ')
  view.rerender(<Composer {...p} commands={commands} draft="/cmd19 workspace" />)
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(screen.getByRole('note').textContent).toContain('/cmd19')
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(p.send).toHaveBeenCalledTimes(1)
})
const codexModel = {
  id: 'gpt-fixture', provider: 'openai-codex', api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api',
}
const readyUsage: CodexUsageSnapshot = {
  provider: 'openai-codex', state: 'ready', reason: null, capturedAt: null, stale: false,
  windows: [{ durationSeconds: 18000, remainingPercent: 50, resetsAt: null }],
}
it.each([
  undefined,
  { id: 'deepseek-chat', provider: 'deepseek', api: 'openai-completions' },
  { id: 'codex', name: 'OpenAI Codex', provider: 'custom', api: 'openai-completions' },
  { ...codexModel, provider: 'openai', api: 'openai-responses' },
  { ...codexModel, api: 'openai-responses' },
  { ...codexModel, baseUrl: 'https://proxy.test/backend-api' },
])('hides all Codex quota states for an unsupported current model: %j', (model) => {
  const p = props()
  const session = { ...p.session, state: { model } }
  const view = render(<Composer {...p} session={session} usage={readyUsage} />)
  for (const usage of [
    readyUsage,
    { ...readyUsage, state: 'error' as const, stale: true, reason: 'request-failed' as const },
    { ...readyUsage, state: 'unavailable' as const, windows: [], reason: 'unsupported-subscription' as const },
  ]) {
    view.rerender(<Composer {...p} session={session} usage={usage} />)
    expect(screen.queryByLabelText('Codex subscription allowance')).toBeNull()
    expect(screen.queryByText('Quota unavailable')).toBeNull()
    expect(screen.queryByText('Update delayed')).toBeNull()
    expect(screen.getByText('↵ Send · ⇧↵ New line')).toBeTruthy()
  }
})
it('updates quota visibility when switching models without dropping quota errors for a supported model', () => {
  const p = props()
  const usage = { ...readyUsage, state: 'error' as const, windows: [], reason: 'timeout' as const }
  const codexSession = { ...p.session, state: { model: codexModel } }
  const view = render(<Composer {...p} session={codexSession} usage={usage} />)
  expect(screen.getByText('Quota unavailable')).toBeTruthy()
  view.rerender(<Composer {...p} usage={usage} session={{
    ...p.session, state: { model: { id: 'deepseek-chat', provider: 'deepseek' } },
  }} />)
  expect(screen.queryByLabelText('Codex subscription allowance')).toBeNull()
  view.rerender(<Composer {...p} session={codexSession} usage={readyUsage} />)
  expect(screen.getByText('50% left')).toBeTruthy()
})
it('keeps quota and hints in one footer, preserving statuses and busy hints', () => {
  const p = props()
  p.session.state.model = codexModel
  const view = render(<Composer {...p} usage={{
    provider: 'openai-codex', state: 'ready', reason: null, capturedAt: null, stale: false,
    windows: [{ durationSeconds: 18000, remainingPercent: 50, resetsAt: null }],
  }} statuses={{ extension: 'Ready' }} />)
  const footer = screen.getByRole('group', { name: 'Allowance and keyboard shortcuts' })
  expect(footer.contains(screen.getByLabelText('Codex subscription allowance'))).toBe(true)
  expect(footer.contains(screen.getByText('↵ Send · ⇧↵ New line'))).toBe(true)
  expect(footer.contains(screen.getByText('Ready'))).toBe(true)
  expect(footer.children).toHaveLength(2)
  expect(footer.querySelector('.composer-shortcuts')).toBe(footer.lastElementChild)
  view.rerender(<Composer {...p} busy />)
  expect(screen.queryByLabelText('Codex subscription allowance')).toBeNull()
  expect(footer.querySelector('.composer-footer-left')?.childElementCount).toBe(0)
  expect(screen.getByText('↵ Steer · ⌥↵ Follow-up · ⇧↵ New line · Esc Stop')).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', altKey: true })
  expect(p.send).toHaveBeenLastCalledWith('followUp')
})

it('shows session tasks only when the todo plugin is enabled', () => {
  const p = props()
  const view = render(
    <Composer
      {...p}
      session={{ ...p.session, todo: { availability: 'enabled', tasks: [] } } as Snapshot}
    />,
  )
  expect(screen.getByRole('button', { name: /Todo/ })).toBeTruthy()
  view.rerender(
    <Composer
      {...p}
      session={{ ...p.session, todo: { availability: 'disabled', tasks: [] } } as Snapshot}
    />,
  )
  expect(screen.queryByRole('button', { name: /Todo/ })).toBeNull()
})

it('offers cancellation instead of submission while running', () => {
  const p = props()
  render(<Composer {...p} busy />)
  fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }))
  expect(p.stop).toHaveBeenCalledTimes(1)
  expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).disabled).toBe(true)
})
