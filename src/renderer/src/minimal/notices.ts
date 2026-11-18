import type { Message } from '../../../../packages/shared/desktop'
export interface SessionNotice {
  id: number
  text: string
  level: 'info' | 'warning' | 'error'
  after?: string
  key?: string
}
export const noticeAnchor = (message?: Message) =>
  message ? `${message.role}:${message.timestamp}` : undefined
/** UI-only events: never send these to Pi or insert them into native JSONL. */
export function withNotices(messages: Message[], notices: SessionNotice[]): Message[] {
  if (!notices.length) return messages
  const indices = new Map(messages.map((message, i) => [noticeAnchor(message), i]))
  const buckets = new Map<number, Message[]>()
  for (const notice of notices) {
    // A compaction can remove the anchor. Keep these notices at the start, not at
    // the end of a newer response where they would imply the wrong chronology.
    const index = notice.after ? (indices.get(notice.after) ?? -1) : -1
    const bucket = buckets.get(index) || []
    bucket.push({
      role: 'desktopNotice',
      timestamp: notice.id,
      content: notice.text,
      details: { level: notice.level },
    })
    buckets.set(index, bucket)
  }
  return [
    ...(buckets.get(-1) || []),
    ...messages.flatMap((message, i) => [message, ...(buckets.get(i) || [])]),
  ]
}
