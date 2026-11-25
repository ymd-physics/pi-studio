import type { ContentBlock, Message, PiRecord } from '../../../../packages/shared/desktop'

export function applyMessageEvent(messages: Message[], event: PiRecord): Message[] {
  if (event.type === 'message_start') return [...messages, event.message]
  if (event.type === 'message_end') {
    const index = messages.findLastIndex(
      (m) =>
        m.role === event.message.role &&
        (m.timestamp === event.message.timestamp || (m.role === 'assistant' && m.stopReason === 'pending')),
    )
    if (index < 0) return [...messages, event.message]
    return messages.map((message, i) => (i === index ? event.message : message))
  }
  if (event.type !== 'message_update') return messages
  const index = messages.findLastIndex((m) => m.role === 'assistant')
  if (index < 0) return messages
  if (event.message) return messages.map((message, i) => (i === index ? event.message : message))
  const update = event.assistantMessageEvent
  if (typeof update?.type !== 'string' || !Number.isInteger(update.contentIndex) || update.contentIndex < 0) return messages
  if (update.type === 'toolcall_end' && update.toolCall?.type !== 'toolCall') return messages
  const message = messages[index]
  const blocks: ContentBlock[] = Array.isArray(message.content) ? message.content.slice() : []
  const old = blocks[update.contentIndex]
  if (update.type.startsWith('text_'))
    blocks[update.contentIndex] = {
      type: 'text',
      text: update.type === 'text_end' ? update.content : (old?.text || '') + (update.delta || ''),
    }
  if (update.type.startsWith('thinking_'))
    blocks[update.contentIndex] = {
      type: 'thinking',
      thinking:
        update.type === 'thinking_end' ? update.content : (old?.thinking || '') + (update.delta || ''),
    }
  if (update.type === 'toolcall_start')
    blocks[update.contentIndex] = { type: 'toolCall', id: update.id, name: update.toolName }
  if (update.type === 'toolcall_end') blocks[update.contentIndex] = update.toolCall
  return messages.map((m, i) => (i === index ? { ...message, content: blocks } : m))
}
export function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content
  return (
    message.content
      ?.filter((b) => b?.type === 'text')
      .map((b) => b.text || '')
      .join('\n') ||
    message.summary ||
    message.output ||
    ''
  )
}
