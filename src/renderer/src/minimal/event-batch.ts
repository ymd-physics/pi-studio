import type { PiRecord } from '../../../../packages/shared/desktop'

/** Batch only high-frequency visual deltas; semantic boundaries and dialogs flush
 * synchronously. Concatenation preserves every character, not just the latest token. */
export class EventBatch {
  private pending: PiRecord[] = []
  private timer?: ReturnType<typeof setTimeout>
  constructor(
    private receive: (event: PiRecord) => void,
    private visible: () => boolean,
  ) {}
  push(event: PiRecord) {
    if (!['message_update', 'tool_execution_update'].includes(event.type)) {
      this.flush()
      this.receive(event)
      return
    }
    const previous = this.pending.at(-1)
    const a = previous?.assistantMessageEvent,
      b = event.assistantMessageEvent
    if (
      event.type === 'message_update' &&
      previous?.type === event.type &&
      !event.message &&
      !previous.message &&
      a?.type === b?.type &&
      ['text_delta', 'thinking_delta'].includes(b?.type) &&
      a.contentIndex === b.contentIndex
    ) {
      this.pending[this.pending.length - 1] = {
        ...event,
        assistantMessageEvent: { ...b, delta: a.delta + b.delta },
      }
    } else if (
      event.type === 'tool_execution_update' &&
      previous?.type === event.type &&
      previous.toolCallId === event.toolCallId
    ) {
      // Pi's partialResult is a complete snapshot, unlike assistant deltas.
      this.pending[this.pending.length - 1] = event
    } else this.pending.push(event)
    this.timer ??= setTimeout(() => this.flush(), this.visible() ? 32 : 200)
  }
  flush() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const events = this.pending
    this.pending = []
    events.forEach(this.receive)
  }
  dispose() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.pending = []
    this.timer = undefined
  }
}
