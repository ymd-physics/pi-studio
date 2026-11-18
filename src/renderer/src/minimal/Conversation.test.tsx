// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LanguageContext } from './language'
import { Conversation } from './Conversation'
import { emptyActivity } from './activity'
import type { Message } from '../../../../packages/shared/desktop'
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as any).desktop
})
const call = (id: string, name = 'bash') => ({
  type: 'toolCall',
  id,
  name,
  arguments: { command: 'echo ' + id },
})
const messages: Message[] = [
  { role: 'assistant', timestamp: 1, content: [call('a'), call('b'), call('c')] },
  { role: 'toolResult', toolCallId: 'a', content: 'first private output' },
  { role: 'toolResult', toolCallId: 'b', content: 'exit code 2', isError: true },
]
it('renders tool counts as Chinese phrases without translating tool identifiers', () => {
  render(<LanguageContext.Provider value="zh-CN"><Conversation messages={[{ role: 'assistant', content: ['todo','todo','read','read','bash'].map((name, i) => call(String(i), name)) }]} busy={false} activity={emptyActivity()} /></LanguageContext.Provider>)
  expect(screen.getByRole('button', { name: '5 次工具调用' })).toBeTruthy()
  expect(within(screen.getByLabelText('工具明细')).getByText('todo')).toBeTruthy()
})

it('uses two disclosure levels, keeps active rows visible, and preserves individual expansion across collapse/growth', () => {
  const activity = emptyActivity()
  activity.tools.c = { status: 'running' }
  const view = render(<Conversation messages={messages} busy activity={activity} />)
  expect(screen.getByText('1 failed')).toBeTruthy()
  expect(screen.queryByText('first private output')).toBeNull()
  expect(screen.getByRole('button', { name: /echo c running/ })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /echo a/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '3 tool calls' }))
  expect(screen.queryByText('first private output')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /echo a succeeded/ }))
  expect(screen.getByText('first private output')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '3 tool calls' }))
  expect(screen.queryByText('first private output')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '3 tool calls' }))
  expect(screen.getByText('first private output')).toBeTruthy()
  view.rerender(
    <Conversation
      messages={[...messages, { role: 'assistant', timestamp: 2, content: [call('d')] }]}
      busy
      activity={activity}
    />,
  )
  expect(screen.getByRole('button', { name: '4 tool calls' }).getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('first private output')).toBeTruthy()
})
it('separates summary status and tool tags, omitting meaningless diffs for read-only calls', () => {
  const history: Message[] = [
    { role: 'assistant', timestamp: 1, content: [call('read-1', 'read')] },
    { role: 'toolResult', toolCallId: 'read-1', content: 'file text' },
  ]
  const view = render(<Conversation messages={history} busy={false} />)
  expect(screen.getByLabelText('Tool execution status').textContent).toBe('All succeeded')
  expect(screen.getByLabelText('Tool breakdown').textContent).toBe('read1')
  expect(screen.queryByText('Changes')).toBeNull()
  view.rerender(
    <Conversation
      messages={[
        { role: 'assistant', timestamp: 1, content: [call('edit-1', 'edit')] },
        { role: 'toolResult', toolCallId: 'edit-1', content: 'Edited' },
      ]}
      busy={false}
    />,
  )
  expect(screen.getByText('Changes')).toBeTruthy()
  expect(screen.getByText('1 edit diff unavailable')).toBeTruthy()
})
it('shows each successful edit count beside its file, keeps the outer sum, and labels writes separately', () => {
  const history: Message[] = [
    { role: 'assistant', timestamp: 1, content: [
      { type: 'toolCall', id: 'reference', name: 'edit', arguments: { path: 'reference.bib' } },
      { type: 'toolCall', id: 'chapter', name: 'edit', arguments: { path: 'chapters/magic.tex' } },
      { type: 'toolCall', id: 'notes', name: 'write', arguments: { path: 'notes.md', content: 'one\ntwo\n' } },
    ] },
    { role: 'toolResult', toolCallId: 'reference', details: { diff: '-1 old\n-2 old\n' + Array.from({ length: 8 }, (_, i) => `+${i + 1} new`).join('\n') } },
    { role: 'toolResult', toolCallId: 'chapter', details: { diff: '-1 old\n-2 old\n-3 old\n' + Array.from({ length: 22 }, (_, i) => `+${i + 1} new`).join('\n') } },
    { role: 'toolResult', toolCallId: 'notes', content: 'Successfully wrote to notes.md' },
  ]
  const view = render(<Conversation messages={history} busy={false} />)
  const breakdown = screen.getByLabelText('Tool breakdown')
  expect(breakdown.textContent).toContain('Changes+30−5')
  expect(view.container.querySelector('.tool-call-changes')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '3 tool calls' }))
  const reference = screen.getByText('reference.bib').closest('button')!
  expect(within(reference).getByLabelText('8 lines added, 2 lines removed').textContent).toBe('+8−2')
  const chapter = screen.getByText('chapters/magic.tex').closest('button')!
  expect(within(chapter).getByLabelText('22 lines added, 3 lines removed').textContent).toBe('+22−3')
  const write = screen.getByText('notes.md').closest('button')!
  expect(within(write).getByText('Written 2 lines')).toBeTruthy()
  expect(write.querySelector('.tool-call-changes')).toBeNull()
  fireEvent.click(reference)
  expect(screen.getByText('Native edit diff — reported by tool')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '3 tool calls' }))
  fireEvent.click(screen.getByRole('button', { name: '3 tool calls' }))
  expect(screen.getByText('Native edit diff — reported by tool')).toBeTruthy()
  expect(breakdown.textContent).toContain('Changes+30−5')
})
it.each(['pending', 'running', 'failed'] as const)('does not report changes for %s edits or writes, even with partial result data', (status) => {
  const history: Message[] = [{ role: 'assistant', timestamp: 1, content: [
    { type: 'toolCall', id: 'edit', name: 'edit', arguments: { path: 'a.ts' } },
    { type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'b.ts', content: 'unconfirmed\n' } },
  ] }]
  const activity = emptyActivity()
  for (const id of ['edit', 'write']) activity.tools[id] = { status, result: {
    role: 'toolResult', isError: status === 'failed', details: { diff: '+1 unconfirmed' },
  } }
  const view = render(<Conversation messages={history} busy={status !== 'failed'} activity={activity} />)
  fireEvent.click(screen.getByRole('button', { name: '2 tool calls' }))
  expect(view.container.querySelector('.tool-call-changes')).toBeNull()
  expect(view.container.querySelector('.tool-write-count')).toBeNull()
  expect(view.container.querySelector('.tool-diff-missing')).toBeNull()
})
it.each([undefined, 42, 'malformed', '+1 new\ncorrupt diff data', '@@ -1,2 +1,2 @@\n-a\n+b', '@@ -1 +1 @@\n-a\n+b\n+unaccounted', '@@ -1 +1 @@\n-a\n+b\n+++ unaccounted'])('marks an unavailable successful edit diff honestly: %j', (diff) => {
  render(<Conversation busy={false} messages={[
    { role: 'assistant', timestamp: 1, content: [{ type: 'toolCall', id: 'a', name: 'edit', arguments: { path: 'a.ts', oldText: 'old', newText: 'new\nextra' } }] },
    { role: 'toolResult', toolCallId: 'a', details: { diff } },
  ]} />)
  fireEvent.click(screen.getByRole('button', { name: '1 tool call' }))
  const row = screen.getByText('a.ts').closest('button')!
  expect(within(row).getByText('Diff unavailable')).toBeTruthy()
  expect(row.querySelector('.tool-call-changes')).toBeNull()
})
it('updates counts from live final results and arguments before the full native message refresh', () => {
  const history: Message[] = [{ role: 'assistant', timestamp: 1, content: [
    { type: 'toolCall', id: 'edit', name: 'edit', arguments: { path: 'a.ts' } },
    { type: 'toolCall', id: 'write', name: 'write', arguments: {} },
  ] }]
  const running = emptyActivity()
  running.tools.edit = { status: 'running' }
  running.tools.write = { status: 'running' }
  const view = render(<Conversation messages={history} busy activity={running} />)
  fireEvent.click(screen.getByRole('button', { name: '2 tool calls' }))
  const final = emptyActivity()
  final.tools.edit = { status: 'succeeded', result: { role: 'toolResult', details: { diff: '' } } }
  final.tools.write = { status: 'succeeded', args: { path: 'live.ts', content: 'one' }, result: { role: 'toolResult' } }
  view.rerender(<Conversation messages={history} busy={false} activity={final} />)
  expect(screen.getByLabelText('0 lines added, 0 lines removed').textContent).toBe('+0−0')
  expect(screen.getByText('Written 1 line')).toBeTruthy()
  expect(screen.getByText('live.ts')).toBeTruthy()
})
it('omits write counts when submitted content is unavailable and reports an empty write as zero lines', () => {
  render(<Conversation busy={false} messages={[
    { role: 'assistant', timestamp: 1, content: [
      { type: 'toolCall', id: 'missing', name: 'write', arguments: { path: 'missing.ts' } },
      { type: 'toolCall', id: 'empty', name: 'write', arguments: { path: 'empty.ts', content: '' } },
    ] },
    { role: 'toolResult', toolCallId: 'missing' },
    { role: 'toolResult', toolCallId: 'empty' },
  ]} />)
  fireEvent.click(screen.getByRole('button', { name: '2 tool calls' }))
  expect(screen.getAllByText(/^Written/)).toHaveLength(1)
  expect(screen.getByText('Written 0 lines')).toBeTruthy()
  expect(screen.queryByText('Changes')).toBeNull()
})
it('preserves expanded thinking when it joins a collapsed group and never invents historical durations', () => {
  const thought: Message = {
    role: 'assistant',
    timestamp: 1,
    content: [{ type: 'thinking', thinking: 'Reasoning details' }],
  }
  const view = render(<Conversation messages={[thought]} busy={false} />)
  const button = screen.getByRole('button', { name: 'Thought' })
  fireEvent.click(button)
  view.rerender(
    <Conversation
      messages={[{ ...thought, content: [...(thought.content as any[]), call('a')] }]}
      busy={false}
    />,
  )
  expect(screen.getByRole('button', { name: 'Thought' }).getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('Reasoning details')).toBeTruthy()
  expect(screen.queryByLabelText('Response statistics')).toBeNull()
})
it('follows growing tool output only while the reader is at the bottom', () => {
  const activity = emptyActivity()
  activity.tools.c = { status: 'running' }
  const view = render(<Conversation messages={messages} busy activity={activity} />)
  const scroll = view.container.querySelector('.conversation') as HTMLDivElement
  let height = 600
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, value: 200 },
  })
  fireEvent.click(screen.getByRole('button', { name: /echo c running/ }))
  const next = {
    ...activity,
    tools: {
      c: { status: 'running' as const, result: { role: 'toolResult', content: 'Growing live output' } },
    },
  }
  view.rerender(<Conversation messages={messages} busy activity={next} />)
  expect(scroll.scrollTop).toBe(600)
  scroll.scrollTop = 0
  fireEvent.scroll(scroll)
  height = 900
  view.rerender(<Conversation messages={messages} busy activity={{ ...next, tools: { ...next.tools } }} />)
  expect(scroll.scrollTop).toBe(0)
})
it('preserves scroll ownership while hidden and follows new output when shown again', () => {
  const view = render(<Conversation messages={messages} busy={false} />)
  const scroll = view.container.querySelector('.conversation') as HTMLDivElement
  let height = 600
  Object.defineProperties(scroll, { scrollHeight: { get: () => height }, clientHeight: { value: 200 } })
  view.rerender(<Conversation messages={messages} busy active={false} />)
  height = 900
  fireEvent.scroll(scroll)
  expect(scroll.scrollTop).toBe(0)
  view.rerender(<Conversation messages={messages} busy active />)
  expect(scroll.scrollTop).toBe(900)
  scroll.scrollTop = 200
  fireEvent.scroll(scroll)
  view.rerender(<Conversation messages={messages} busy active={false} />)
  height = 1200
  view.rerender(<Conversation messages={messages} busy active />)
  expect(scroll.scrollTop).toBe(200)
})
it('bounds long custom transcripts even when native messages share a timestamp', () => {
  const history = Array.from({ length: 140 }, (_, i) => ({
    role: 'custom',
    timestamp: Math.floor(i / 3),
    content: `History ${i}`,
  }))
  const view = render(<Conversation messages={history.slice(0, 80)} busy={false} />)
  view.rerender(<Conversation messages={history} busy={false} />)
  expect(view.container.querySelectorAll('.message')).toHaveLength(100)
  fireEvent.click(screen.getByRole('button', { name: /Show earlier messages/ }))
  expect(view.container.querySelectorAll('.message')).toHaveLength(140)
})
it('updates live clocks without model deltas and freezes completed thought duration', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  const activity = emptyActivity()
  activity.active = { started: 0, phase: 'Working' }
  activity.thoughts['assistant:1:thinking:0'] = { started: 0 }
  const history: Message[] = [
    { role: 'assistant', timestamp: 1, content: [{ type: 'thinking', thinking: '' }] },
  ]
  const view = render(<Conversation messages={history} busy activity={activity} />)
  act(() => vi.advanceTimersByTime(3000))
  expect(screen.getByRole('button', { name: 'Thinking… 3s' })).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('3s')
  activity.thoughts['assistant:1:thinking:0'] = { started: 0, ended: 3000 }
  activity.active = undefined
  view.rerender(<Conversation messages={history} busy={false} activity={activity} />)
  act(() => vi.advanceTimersByTime(5000))
  expect(screen.getByRole('button', { name: 'Thought 3s' })).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
})

it('mounts tool-result images only while their group is expanded and closes the lightbox with Escape', async () => {
  window.desktop = {
    imageThumbnail: vi.fn().mockResolvedValue({
      dataUrl: 'data:image/jpeg;base64,AAAA',
      width: 1600,
      height: 900,
    }),
  } as any
  const history: Message[] = [
    {
      role: 'assistant',
      timestamp: 1,
      content: [{ type: 'toolCall', id: 'shot-1', name: 'read', arguments: { path: '/tmp/shot.png' } }],
    },
    {
      role: 'toolResult',
      toolCallId: 'shot-1',
      content: [
        { type: 'text', text: 'Read image file [image/png]' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      ],
    },
  ]
  render(<Conversation messages={history} busy={false} />)
  expect(screen.queryByRole('button', { name: 'Open shot.png' })).toBeNull()
  expect(window.desktop.imageThumbnail).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Tool breakdown').textContent).toContain('images1')
  fireEvent.click(screen.getByRole('button', { name: '1 tool call' }))
  expect(await screen.findByRole('button', { name: 'Open shot.png' })).toBeTruthy()
  expect(window.desktop.imageThumbnail).toHaveBeenCalledWith('AAAA', 'image/png', { width: 128, height: 78 })
  const opener = screen.getByRole('button', { name: 'Open shot.png' })
  fireEvent.click(opener)
  expect(screen.getByRole('dialog', { name: 'Image: shot.png' })).toBeTruthy()
  const keydown = vi.fn()
  document.addEventListener('keydown', keydown)
  fireEvent.keyDown(document, { key: 'Escape' })
  document.removeEventListener('keydown', keydown)
  expect((keydown.mock.calls[0][0] as KeyboardEvent).defaultPrevented).toBe(true)
  expect(screen.queryByRole('dialog', { name: 'Image: shot.png' })).toBeNull()
  expect(document.activeElement).toBe(opener)
  fireEvent.click(screen.getByRole('button', { name: '1 tool call' }))
  expect(screen.queryByRole('button', { name: 'Open shot.png' })).toBeNull()
})

it('renders user image attachments and non-image file cards without exposing the path block', async () => {
  window.desktop = {
    imageThumbnail: vi.fn().mockResolvedValue({
      dataUrl: 'data:image/jpeg;base64,AAAA',
      width: 800,
      height: 600,
    }),
    fileSizes: vi.fn().mockResolvedValue({ '.pi/attachments/report.pdf': 2048 }),
  } as any
  const history: Message[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Compare these.\nAttached workspace files (use native file tools when needed):\n".pi/attachments/a.png"\n".pi/attachments/report.pdf"',
        },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      ],
    },
  ]
  render(<Conversation messages={history} busy={false} handle="test-handle" />)
  expect(screen.queryByText(/Attached workspace files/)).toBeNull()
  expect(await screen.findByRole('button', { name: 'Open a.png' })).toBeTruthy()
  expect(screen.getByText('report.pdf')).toBeTruthy()
  expect(await screen.findByText('PDF file · 2 KB')).toBeTruthy()
  expect(window.desktop.fileSizes).toHaveBeenCalledWith('test-handle', ['.pi/attachments/report.pdf'])
})

it('shows a placeholder instead of loading a rejected full image', async () => {
  window.desktop = { imageThumbnail: vi.fn().mockResolvedValue(null) } as any
  const history: Message[] = [
    {
      role: 'assistant',
      timestamp: 1,
      content: [{ type: 'toolCall', id: 'shot-2', name: 'read', arguments: { path: '/tmp/shot.png' } }],
    },
    {
      role: 'toolResult',
      toolCallId: 'shot-2',
      content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
    },
  ]
  render(<Conversation messages={history} busy={false} />)
  fireEvent.click(screen.getByRole('button', { name: '1 tool call' }))
  expect(await screen.findByText('Preview unavailable')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Open shot.png' })).toBeNull()
})
