// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TodoButton } from './TodoButton'
import { ExtensionDialog } from './ExtensionDialog'
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it('fetches only on open, pages past five tasks and loads completed items separately', async () => {
  const command = vi.fn(async (_type, { group, offset }) => Array.from({ length: group === 'completed' || offset ? 1 : 24 }, (_, n) => ({ id: offset+n+1, status: group === 'completed' ? 'completed' : 'pending', subject: `${group} ${offset+n+1}` })))
  vi.stubGlobal('desktop', { command })
  try {
    render(<><TodoButton handle="a" state={{ availability: 'enabled', revision: 'r', total: 26, completed: 1 }} /><button>Outside</button></>)
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Todo/ }))
    await screen.findByText('active 8')
    fireEvent.click(screen.getByRole('button', { name: 'Load more tasks' }))
    await screen.findByText('active 25')
    expect(command).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Completed (1)' }))
    await screen.findByText('completed 1')
    fireEvent.pointerDown(screen.getByText('Outside'))
    expect(screen.queryByLabelText('Session todo')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Todo/ }))
    await screen.findByText('active 1')
    expect(screen.queryByText('completed 1')).toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: /Todo/ }), { key: 'Escape' })
    expect(screen.queryByLabelText('Session todo')).toBeNull()
  } finally { vi.unstubAllGlobals() }
})
it('full text is available even below character thresholds; inspection never grants permission', () => {
  const answer = vi.fn(),
    option = 'Ｗ'.repeat(80),
    title = 'W'.repeat(90)
  render(
    <ExtensionDialog
      request={{ type: 'extension_ui_request', id: '1', method: 'select', title, options: [option] }}
      context="Workspace / Session"
      answer={answer}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Read full option 1' }))
  expect(screen.getByRole('region', { name: 'Full request text' }).textContent).toContain(option)
  expect(answer).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Close full text' }))
  fireEvent.click(screen.getByRole('button', { name: 'Read full request title' }))
  expect(screen.getByRole('region', { name: 'Full request text' }).textContent).toContain(title)
  fireEvent.keyDown(screen.getByRole('button', { name: 'Read full request title' }), { key: 'Escape' })
  expect(answer).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('radio', { name: option }))
  expect(answer).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(answer).toHaveBeenCalledWith({ value: option })
})
it('requires an explicit choice and preserves the original native response including ANSI', () => {
  const answer = vi.fn()
  const option = '\u001b[32mAllow exactly once\u001b[0m'
  const { container } = render(<ExtensionDialog request={{ type: 'extension_ui_request', id: 'select', method: 'select', title: 'Permission', options: [option] }} context="Workspace / A" answer={answer} />)
  fireEvent.submit(container.querySelector('form')!)
  expect(answer).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('radio', { name: 'Allow exactly once' }))
  expect(answer).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(answer).toHaveBeenCalledWith({ value: option })
})
it('preserves editor drafts while reading and backgrounded without answering', () => {
  const answer = vi.fn(), onReadingChange = vi.fn()
  const props = { request: { type: 'extension_ui_request', id: 'edit', method: 'editor', title: 'Notes', prefill: 'Original' }, context: 'Workspace / A', answer, onReadingChange }
  const view = render(<ExtensionDialog {...props} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'My draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'View conversation' }))
  expect(onReadingChange).toHaveBeenCalledWith(true)
  view.rerender(<ExtensionDialog {...props} reading />)
  expect(screen.queryByRole('dialog')).toBeNull()
  view.rerender(<ExtensionDialog {...props} active={false} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(answer).not.toHaveBeenCalled()
  view.rerender(<ExtensionDialog {...props} />)
  expect((screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement).value).toBe('My draft')
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(answer).toHaveBeenCalledWith({ value: 'My draft' })
})
