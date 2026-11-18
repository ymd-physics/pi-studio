// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Message } from '../../../../packages/shared/desktop'
import { Conversation } from './Conversation'
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }))
afterEach(cleanup)
const request: Message = { role: 'custom', customType: 'subagent_supervisor_request', content: 'Reply with: subagent_supervisor(...); RUN-ID-PRIVATE', details: {
  requestId: 'req-1', runId: 'run-1', agent: 'reviewer', childIndex: 0, reason: 'need_decision', expectsReply: true,
  requestBody: '<script>bad()</script> 请补充缺失的证据。'.repeat(12) } }
it('renders a bounded expandable request instead of protocol prose; drafting is explicit and read-only', async () => {
  const draft = vi.fn(), original = JSON.stringify(request)
  render(<Conversation messages={[request]} busy={false} onSubagentDraft={draft} />)
  expect(screen.getByRole('article', { name: 'reviewer needs a decision' })).toBeTruthy()
  expect(screen.queryByText(/RUN-ID-PRIVATE/)).toBeNull()
  expect(document.querySelector('script')).toBeNull()
  expect(draft).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Show full request' }))
  expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Draft guidance to parent ↗' }))
  expect(draft).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-1' }))
  const details = document.querySelector('details')!
  details.open = true; fireEvent(details, new Event('toggle'))
  await waitFor(() => expect(screen.getByText(/RUN-ID-PRIVATE/)).toBeTruthy())
  expect(JSON.stringify(request)).toBe(original)
})
it('shows unknown formats unchanged and respects hidden custom messages', () => {
  render(<Conversation messages={[{ ...request, display: false }, { role: 'custom', customType: 'future-subagents', content: 'Unknown format preserved' }]} busy={false} />)
  expect(screen.queryByRole('article', { name: 'reviewer needs a decision' })).toBeNull()
  expect(screen.getByText('Unknown format preserved')).toBeTruthy()
})
it('navigates to a request beyond transcript pagination without inferring it is still pending', async () => {
  const messages: Message[] = [request, ...Array.from({ length: 110 }, (_, i): Message => ({ role: 'user', content: `message ${i}` }))]
  const view = render(<Conversation messages={messages} busy={false} />)
  expect(screen.queryByRole('article', { name: 'reviewer needs a decision' })).toBeNull()
  view.rerender(<Conversation messages={messages} busy={false} requestNavigation={{ requestId: 'req-1', sequence: 1 }} />)
  const article = await screen.findByRole('article', { name: 'reviewer needs a decision' })
  await waitFor(() => expect(document.activeElement).toBe(article))
  expect(article.textContent).toContain('current resolution not inferred')
})
it('only offers related request navigation for visible validated request IDs', () => {
  render(<Conversation busy={false} messages={[request, { role: 'custom', customType: 'subagent-supervisor-blocked', content: 'Native reminder', details: { requestIds: ['req-1', 'missing'] } }]} />)
  expect(screen.getByRole('button', { name: 'View request · req-1' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'View request · missing' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'View request · req-1' }))
  expect(document.activeElement).toBe(screen.getByRole('article', { name: 'reviewer needs a decision' }))
})
