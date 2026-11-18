import type { ContentBlock, Message } from '../../../../packages/shared/desktop'
import { stripAnsi } from '../../../../packages/shared/ansi'
import { messageText } from './transcript'
import { countGroupDiff } from './tool-diff'

export const messageKey = (message: Message, index = 0) =>
  `${message.role}:${message.timestamp ?? `index-${index}`}`
export type ThoughtRow = { kind: 'thought'; key: string; messageKey: string; start: number; text: string }
export type ToolRow = { kind: 'tool'; key: string; call: ContentBlock }
export type ProcessRow = ThoughtRow | ToolRow
export type TranscriptRow =
  | ProcessRow
  | { kind: 'message'; key: string; message: Message }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'notice'; key: string; message: Message }
  | { kind: 'group'; key: string; children: ProcessRow[] }
  | { kind: 'ending'; key: string; messageKey: string }

/** Presentation only. First native tool ID anchors a group; prose/unknown content is a hard boundary. */
export function projectTranscript(messages: Message[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  const occurrences = new Map<string, number>()
  let group: Extract<TranscriptRow, { kind: 'group' }> | undefined
  let lastAssistant: string | undefined
  const bridgeThoughts = new Set<string>()
  const endReply = () => {
    if (lastAssistant)
      rows.push({ kind: 'ending', key: `ending:${lastAssistant}`, messageKey: lastAssistant })
    lastAssistant = undefined
    group = undefined
    bridgeThoughts.clear()
  }
  messages.forEach((message, index) => {
    if (message.role === 'toolResult') return
    const base = messageKey(message, index)
    const occurrence = occurrences.get(base) || 0
    occurrences.set(base, occurrence + 1)
    // Native timestamps are not IDs: batch custom entries can share a millisecond.
    const key = occurrence ? `${base}#${occurrence}` : base
    if (message.role !== 'assistant') {
      if (message.role === 'user') endReply()
      group = undefined
      bridgeThoughts.clear()
      if (message.display !== false) rows.push({ kind: 'message', key, message })
      return
    }
    lastAssistant = key
    if (message.display === false) {
      group = undefined
      bridgeThoughts.clear()
      return
    }
    const blocks = Array.isArray(message.content)
      ? message.content
      : [{ type: 'text', text: messageText(message) }]
    const bridge =
      !['length', 'error', 'aborted'].includes(message.stopReason || '') &&
      blocks.every(
        (b) => b.type === 'thinking' || b.type === 'toolCall' || (b.type === 'text' && !b.text?.trim()),
      )
    if (!bridge) {
      group = undefined
      bridgeThoughts.clear()
    }
    const calls: ToolRow[] = []
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      if (block.type === 'thinking') {
        const start = i
        let text = block.thinking || ''
        while (blocks[i + 1]?.type === 'thinking') text += '\n' + (blocks[++i].thinking || '')
        const row: ThoughtRow = {
          kind: 'thought',
          key: `${key}:thinking:${start}`,
          messageKey: key,
          start,
          text,
        }
        if (bridge) bridgeThoughts.add(row.key)
        if (group) group.children.push(row)
        else rows.push(row)
      } else if (block.type === 'toolCall') {
        calls.push({ kind: 'tool', key: block.id || `${key}:tool:${i}`, call: block })
      } else {
        if (block.type === 'text' && !block.text?.trim()) continue
        group = undefined
        bridgeThoughts.clear()
        if (block.type === 'text' && block.text)
          rows.push({ kind: 'text', key: `${key}:${i}`, text: block.text })
        else if (block.type !== 'text')
          rows.push({
            kind: 'text',
            key: `${key}:${i}`,
            text:
              block.type === 'image'
                ? 'Image attachment retained in Pi session'
                : `Unsupported ${block.type} content retained in Pi session`,
          })
      }
    }
    if (message.errorMessage || ['aborted', 'error', 'length'].includes(message.stopReason || '')) {
      group = undefined
      bridgeThoughts.clear()
      rows.push({ kind: 'notice', key: `${key}:notice`, message })
    }
    // Match Pi's native component order: assistant thinking/prose, then its tool rows.
    // An assistant containing prose cannot bridge an earlier group.
    for (const row of calls) {
      if (!group) {
        let start = rows.length
        if (bridge)
          while (start > 0 && rows[start - 1].kind === 'thought' && bridgeThoughts.has(rows[start - 1].key))
            start--
        const prefix = rows.splice(start) as ThoughtRow[]
        group = { kind: 'group', key: `group:${row.key}`, children: prefix }
        rows.push(group)
      }
      group.children.push(row)
    }
  })
  endReply()
  return rows
}

const oneLine = (value: unknown) =>
  typeof value === 'string' ? stripAnsi(value).replace(/\s+/g, ' ').trim() : ''
export function toolSummary(call: ContentBlock, workspace = ''): string {
  const a = (call.arguments && typeof call.arguments === 'object' ? call.arguments : {}) as Record<
    string,
    unknown
  >
  const rawPath = oneLine(a.path ?? a.file_path)
  const path =
    workspace && rawPath.startsWith(workspace + '/') ? rawPath.slice(workspace.length + 1) : rawPath
  let summary = ''
  switch (call.name) {
    case 'read':
    case 'edit':
    case 'write':
    case 'ls':
      summary = path
      break
    case 'grep':
    case 'find':
      summary = [oneLine(a.pattern), path].filter(Boolean).join(' · ')
      break
    case 'bash':
      summary = oneLine(a.command)
      break
    case 'todo':
      summary = [oneLine(a.action), a.id != null ? `#${a.id}` : '', oneLine(a.subject ?? a.status)]
        .filter(Boolean)
        .join(' ')
      break
    default: {
      const field = ['path', 'file_path', 'command', 'query', 'pattern', 'url', 'name'].find(
        (key) => typeof a[key] === 'string',
      )
      summary = field
        ? ['path', 'file_path'].includes(field)
          ? path
          : oneLine(a[field])
        : Object.keys(a).slice(0, 3).join(', ')
    }
  }
  return summary.length > 180 ? summary.slice(0, 179) + '…' : summary
}
export type ToolState = 'pending' | 'running' | 'succeeded' | 'failed'
export function toolState(
  call: ContentBlock,
  results: Map<string, Message>,
  live: Record<string, { status: ToolState }>,
): ToolState {
  const result = results.get(call.id || '')
  return result ? (result.isError ? 'failed' : 'succeeded') : live[call.id || '']?.status || 'pending'
}
export function failureLabel(result?: Message): string {
  const text = result ? messageText(result) : ''
  const exit = /(?:exited with (?:code|status)|exit(?: code)?)\s*[:=]?\s*(-?\d+)/i.exec(text)
  return /abort|cancel/i.test(text)
    ? 'cancelled'
    : /timed?\s*out|timeout/i.test(text)
      ? 'timeout'
      : exit
        ? `exit ${exit[1]}`
        : 'failed'
}
export function groupStatistics(
  calls: ContentBlock[],
  results: Map<string, Message>,
  live: Record<string, { status: ToolState }>,
) {
  const tools = new Map<string, number>()
  const states = { pending: 0, running: 0, succeeded: 0, failed: 0 }
  let added = 0,
    removed = 0,
    unavailable = 0
  for (const call of calls) {
    tools.set(call.name || 'tool', (tools.get(call.name || 'tool') || 0) + 1)
    const state = toolState(call, results, live)
    states[state]++
    if (call.name === 'edit' && state === 'succeeded') {
      const diff = countGroupDiff(results.get(call.id || '')?.details?.diff)
      if (diff) {
        added += diff.added
        removed += diff.removed
      } else unavailable++
    }
  }
  return { tools, states, added, removed, unavailable }
}
