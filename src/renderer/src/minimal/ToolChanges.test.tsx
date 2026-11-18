// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ToolChanges } from './ToolChanges'
import { boundedDiagnostic, contentPreview, countContentLines, parseNativeDiff } from './toolChangePreview'
import type { ContentBlock } from '../../../../packages/shared/desktop'

afterEach(cleanup)
const edit: ContentBlock = { type: 'toolCall', name: 'edit', arguments: { path: 'a.ts', oldText: 'old', newText: 'new' } }
it('shows authoritative native diff with original line gutters and blue/red classes', () => {
  const diff = '  9 context\n-10 actual old\n+10 actual new\n+11 extra\n ...'
  expect(parseNativeDiff(diff)?.lines[1]).toEqual({ kind: 'deleted', number: '10', text: 'actual old' })
  const view = render(<ToolChanges call={edit} status="succeeded" result={{ role: 'toolResult', details: { diff } }} />)
  expect(screen.getByText('actual new').closest('.change-added')).toBeTruthy()
  expect(screen.getByText('actual old').closest('.change-deleted')).toBeTruthy()
  expect(view.container.querySelectorAll('.change-number')[1].textContent).toBe('10')
  expect(screen.queryByText('Old text')).toBeNull()
  expect(screen.queryByText('Arguments')).toBeNull()
  const details = view.container.querySelector('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
  expect(screen.getByText('Arguments')).toBeTruthy()
  expect(screen.getByText(/"diff"/)).toBeTruthy()
})
it.each(['pending', 'running', 'failed'] as const)('labels %s edits as unconfirmed even with a diff', (status) => {
  render(<ToolChanges call={edit} status={status} result={{ role: 'toolResult', isError: status === 'failed', content: 'permission denied', details: { diff: '+1 not confirmed' } }} />)
  expect(screen.getByText(/Proposed replacement/)).toBeTruthy()
  expect(screen.queryByText('not confirmed')).toBeNull()
  if (status === 'failed') expect(screen.getByRole('alert').textContent).toBe('permission denied')
  else expect(screen.getByText(`Proposed changes — ${status}`)).toBeTruthy()
})
it('previews the native multi-replacement edits array without claiming it was applied', () => {
  render(<ToolChanges call={{ type: 'toolCall', name: 'edit', arguments: { path: 'a.ts', edits: [{ oldText: 'alpha', newText: 'beta' }, { oldText: 'gamma', newText: 'delta' }] } }} status="pending" />)
  expect(screen.getByText('Replacement 2')).toBeTruthy()
  expect(screen.getByText('gamma').closest('.change-deleted')).toBeTruthy()
  expect(screen.getByText('delta').closest('.change-added')).toBeTruthy()
  expect(screen.queryByText('Replacement content unavailable.')).toBeNull()
})
it('shows writes without inventing removed content or claiming a diff', () => {
  const view = render(<ToolChanges call={{ type: 'toolCall', name: 'write', arguments: { content: 'one\ntwo' } }} status="succeeded" result={{ role: 'toolResult', content: 'Successfully wrote 7 bytes' }} />)
  expect(screen.getByText(/Previous content unavailable; this is not a diff/)).toBeTruthy()
  expect(view.container.querySelector('.change-deleted')).toBeNull()
  expect([...view.container.querySelectorAll('.change-number')].map(el => el.textContent)).toEqual(['1', '2'])
})
it.each([undefined, {}, { diff: 42 }, { diff: 'malformed' }])('handles missing or malformed native results: %j', (details) => {
  render(<ToolChanges call={edit} status="succeeded" result={details ? { role: 'toolResult', details } : undefined} />)
  expect(screen.getByText(/Native diff unavailable/)).toBeTruthy()
  expect(screen.getByText('Old text')).toBeTruthy()
})
it('handles missing arguments and failed writes honestly', () => {
  render(<ToolChanges call={{ type: 'toolCall', name: 'write' }} status="failed" />)
  expect(screen.getByText(/Proposed write content/)).toBeTruthy()
  expect(screen.getByText('Write content unavailable.')).toBeTruthy()
  expect(screen.getByRole('alert')).toBeTruthy()
})
it.each([
  ['', 0], ['one', 1], ['one\n', 1], ['one\ntwo', 2], ['one\ntwo\n', 2],
  ['\n', 1], ['\n\n', 2], ['one\r\ntwo\r\n', 2], ['one\rtwo\r', 2],
  ['one\r\ntwo\nthree\r', 3], [undefined, undefined], [42, undefined],
])('counts written content lines without treating a final newline as an extra line: %j', (content, expected) => {
  expect(countContentLines(content)).toBe(expected)
})
it('counts long written content beyond the bounded preview', () => {
  expect(countContentLines('line\n'.repeat(100000))).toBe(100000)
})
it('bounds huge outputs, lines, and diagnostic strings', () => {
  const huge = 'x'.repeat(1000000)
  expect(contentPreview(huge).lines[0].text.length).toBe(1001)
  expect(contentPreview('x\n'.repeat(100000)).lines).toHaveLength(300)
  expect(contentPreview(huge).truncated).toBe(true)
  expect(boundedDiagnostic({ content: huge }).length).toBeLessThan(30100)
  const view = render(<ToolChanges call={{ type: 'toolCall', name: 'write', arguments: { content: huge } }} status="pending" />)
  expect(screen.getByText(/Preview limited/)).toBeTruthy()
  expect(view.container.textContent!.length).toBeLessThan(2000)
})
