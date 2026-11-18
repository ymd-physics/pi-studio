import { expect, it } from 'vitest'
import type { ContentBlock, Message } from '../../../../packages/shared/desktop'
import { projectTranscript, groupStatistics, toolSummary } from './presentation'
import { countGroupDiff } from './tool-diff'

const call = (id: string, name = 'read'): ContentBlock => ({
  type: 'toolCall',
  id,
  name,
  arguments: { path: '/work/file.ts' },
})
const assistant = (timestamp: number, content: ContentBlock[], extra = {}): Message => ({
  role: 'assistant',
  timestamp,
  content,
  ...extra,
})
const thinking: ContentBlock = { type: 'thinking', thinking: 'Consider this' }
const text: ContentBlock = { type: 'text', text: 'Explanation' }

it('groups native tool-only assistant components across turns with stable first-call identity', () => {
  const messages = [
    assistant(1, [thinking, call('a')]),
    { role: 'toolResult', toolCallId: 'a', content: 'done' },
    assistant(2, [thinking, { type: 'text', text: '  ' }, call('b')]),
  ]
  const groups = projectTranscript(messages).filter((r) => r.kind === 'group')
  expect(groups).toHaveLength(1)
  expect(groups[0].key).toBe('group:a')
  expect(groups[0].children.map((r) => r.kind)).toEqual(['thought', 'tool', 'thought', 'tool'])
  expect(projectTranscript([messages[0]])[0].key).toBe(groups[0].key)
  expect(projectTranscript([assistant(3, [thinking])]).some((r) => r.kind === 'group')).toBe(false)
})
it('prose, user, custom, unknown content, abort and error components break groups', () => {
  for (const middle of [
    assistant(2, [text]),
    { role: 'user', timestamp: 2, content: 'Next' },
    { role: 'custom', timestamp: 2, content: 'Notice' },
    assistant(2, [{ type: 'image' }]),
    assistant(2, [thinking], { stopReason: 'aborted' }),
    assistant(2, [], { errorMessage: 'Failed' }),
  ]) {
    expect(
      projectTranscript([assistant(1, [call('a')]), middle, assistant(3, [call('b')])]).filter(
        (r) => r.kind === 'group',
      ),
    ).toHaveLength(2)
  }
  // Even if prose follows a call in content[], the native assistant component precedes its tool rows.
  expect(
    projectTranscript([assistant(1, [call('a')]), assistant(2, [thinking, call('b'), text])]).filter(
      (r) => r.kind === 'group',
    ),
  ).toHaveLength(2)
})
it('does not absorb trailing thinking from prose or across hidden custom boundaries', () => {
  for (const history of [
    [assistant(1, [text, thinking]), assistant(2, [call('b')])],
    [assistant(1, [thinking]), { role: 'custom', display: false }, assistant(2, [call('b')])],
  ]) {
    const rows = projectTranscript(history)
    expect(rows.filter((r) => r.kind === 'thought')).toHaveLength(1)
    const group = rows.find((r) => r.kind === 'group')
    expect(group?.kind === 'group' && group.children.map((r) => r.kind)).toEqual(['tool'])
  }
})
it('counts only successful native edit diffs and retains failure/pending/running independently', () => {
  const calls = [
    call('a', 'edit'),
    call('b', 'edit'),
    call('c', 'edit'),
    call('d', 'write'),
    call('e', 'bash'),
    call('f', 'read'),
  ]
  const results = new Map<string, Message>([
    ['a', { role: 'toolResult', details: { diff: '-1 old\n+1 new\n+2 extra' } }],
    ['b', { role: 'toolResult' }],
    ['c', { role: 'toolResult', isError: true, details: { diff: '+1 ignored' } }],
    ['d', { role: 'toolResult', details: { diff: '+1 ignored' } }],
  ])
  const stats = groupStatistics(calls, results, { e: { status: 'running' } })
  expect(stats).toMatchObject({
    added: 2,
    removed: 1,
    unavailable: 1,
    states: { succeeded: 3, failed: 1, running: 1, pending: 1 },
  })
  expect([...stats.tools]).toEqual([
    ['edit', 3],
    ['write', 1],
    ['bash', 1],
    ['read', 1],
  ])
})
it('does not include a partially malformed edit diff in the group sum', () => {
  expect(groupStatistics([call('bad', 'edit')], new Map([
    ['bad', { role: 'toolResult', details: { diff: '+1 new\ncorrupt diff data' } }],
  ]), {})).toMatchObject({ added: 0, removed: 0, unavailable: 1 })
})
it('uses bounded summaries without serializing file bodies or unknown large arguments', () => {
  expect(toolSummary(call('a'), '/work')).toBe('file.ts')
  expect(
    toolSummary({
      type: 'toolCall',
      name: 'todo',
      arguments: { action: 'update', id: 3, status: 'completed', description: 'huge' },
    }),
  ).toBe('update #3 completed')
  expect(
    toolSummary({ type: 'toolCall', name: 'unknown', arguments: { content: 'very large', secret: 'value' } }),
  ).toBe('content, secret')
})
it.each(['+unaccounted', '-unaccounted', ' unaccounted', 'corrupt diff data', '+++ unaccounted', '--- unaccounted', '--- a.ts\n+++ b.ts'])('rejects unaccounted content after a completed unified hunk: %s', (extra) => {
  expect(countGroupDiff('@@ -1 +1 @@\n-a\n+b\n' + extra)).toBeUndefined()
  expect(groupStatistics([call('bad', 'edit')], new Map([
    ['bad', { role: 'toolResult', details: { diff: '@@ -1 +1 @@\n-a\n+b\n' + extra } }],
  ]), {})).toMatchObject({ added: 0, removed: 0, unavailable: 1 })
})
it('accepts legitimate unified headers, file transitions, omission-of-final-newline markers and mode metadata', () => {
  expect(countGroupDiff('diff --git a/a.ts b/a.ts\nindex abc123..def456 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\ndiff --git a/b.ts b/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+new file\n')).toEqual({ added: 2, removed: 1 })
  expect(countGroupDiff('Index: a.ts\n===================================================================\n--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-a\n+b\n')).toEqual({ added: 1, removed: 1 })
})
it('counts complete unified/numbered diffs, deduplicates positions and rejects truncated hunks', () => {
  expect(countGroupDiff('@@ -1,2 +1,2 @@\n-a\n+b\n c')).toEqual({ added: 1, removed: 1 })
  expect(countGroupDiff('@@ -1,2 +1,2 @@\n-a\n+b')).toBeUndefined()
  expect(countGroupDiff('+1 x\n+1 x\n-2 y')).toEqual({ added: 1, removed: 1 })
  expect(countGroupDiff(' ...\n 1 context\n-2 old\n+2 new\n …\n')).toEqual({ added: 1, removed: 1 })
  expect(countGroupDiff('+1 new\ncorrupt diff data')).toBeUndefined()
  expect(countGroupDiff('+1 new\n-2')).toBeUndefined()
  expect(countGroupDiff('')).toEqual({ added: 0, removed: 0 })
  expect(countGroupDiff(undefined)).toBeUndefined()
})
