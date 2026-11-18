// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WebBackgroundNotice, WebToolResult } from './WebAccess'
import { Conversation } from './Conversation'
import type { Message } from '../../../../packages/shared/desktop'
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }))
afterEach(cleanup)
const notice: Message = { role: 'custom', customType: 'web-search-content-ready', content: 'Content fetched for 4/6 URLs [example-fetch]. Partial page content now available.' }
it('shows a separate readiness card and keeps the internal reference out of its summary', () => {
  const { container } = render(<WebBackgroundNotice message={notice} />)
  expect(screen.getByText('Partial')).toBeTruthy()
  expect(screen.getByText('2 without retrieved content')).toBeTruthy()
  expect(container.textContent).not.toContain('example-fetch')
  const details = container.querySelector('details')!
  details.open = true; fireEvent(details, new Event('toggle'))
  expect(screen.getByText(String(notice.content))).toBeTruthy()
})
it('does not turn assistant prose, hidden messages or unknown custom formats into notifications', () => {
  const messages: Message[] = [notice, { ...notice, display: false, timestamp: 2 }, { ...notice, role: 'assistant', timestamp: 3 }, { ...notice, timestamp: 4, content: 'Unknown plugin format' }]
  render(<Conversation messages={messages} busy={false} />)
  expect(screen.getAllByLabelText('Web access background update')).toHaveLength(1)
  expect(screen.getByText(String(notice.content))).toBeTruthy()
  expect(screen.getByText('Unknown plugin format')).toBeTruthy()
})
it('shows source cards without fetching and displays generated passage provenance', () => {
  render(<WebToolResult name="source_check" args={{ claim: 'test' }} status="succeeded" result={{ role: 'toolResult', details: { artifact: { sources: [{ url: 'https://example.com', title: 'Example', quality: 'unknown', fetched: false }], passages: [{ source_url: 'https://example.com', text: '<script>not executable</script>', origin: 'provider_summary' }], claims: [{ status: 'unclear', rationale: 'Review manually' }] } } }} />)
  fireEvent.click(screen.getByRole('button', { name: /Example/ }))
  expect(screen.getByText(/Provider summary · not page text/)).toBeTruthy()
  expect(screen.getByText('<script>not executable</script>')).toBeTruthy()
  expect(document.querySelectorAll('script')).toHaveLength(0)
  expect(screen.getByText(/unclear · source assessment/)).toBeTruthy()
  expect(screen.getByText('Not fetched')).toBeTruthy()
})
it('keeps partial counts and browser approval distinct from final success', () => {
  const props = { name: 'web_search', args: {}, status: 'succeeded' as const, result: { role: 'toolResult', details: { queryCount: 2, successfulQueries: 1, totalResults: 3 } } }
  const view = render(<WebToolResult {...props} />)
  expect(screen.getByText('Partial results')).toBeTruthy()
  view.rerender(<WebToolResult {...props} status="running" result={{ role: 'toolResult', details: { phase: 'waiting-for-approval', progress: 1, curatorUrl: 'javascript:alert(1)' } }} />)
  expect(screen.getByText('Needs your review')).toBeTruthy()
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.queryByText('Completed')).toBeNull()
})
it('retains two disclosure levels and does not relabel page coverage as all-success', () => {
  const messages: Message[] = [
    { role: 'assistant', timestamp: 1, content: [{ type: 'toolCall', id: 'web', name: 'web_search', arguments: { query: 'example' } }] },
    { role: 'toolResult', toolCallId: 'web', content: '**Sources:**\n1. Example\n   https://example.com', details: { queryCount: 1, successfulQueries: 1, totalResults: 1 } }, notice,
  ]
  render(<Conversation messages={messages} busy={false} />)
  expect(screen.getByLabelText('Tool execution status').textContent).toBe('Calls completed')
  expect(screen.queryByRole('button', { name: /Discovery link/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '1 tool call' }))
  fireEvent.click(screen.getByRole('button', { name: /web_search.*succeeded/ }))
  expect(screen.getByRole('button', { name: /Discovery link/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '1 tool call' }))
  expect(screen.queryByRole('button', { name: /Discovery link/ })).toBeNull()
})
