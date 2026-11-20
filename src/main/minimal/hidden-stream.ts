import type { PiRecord } from '../../../packages/shared/desktop'

/** Keep only the unfinished visual update for each session, never a token replay log.
 * Control events pass through; a native message_end supersedes its partial text. */
export class HiddenStream {
  private paused = false
  private pending = new Map<string, PiRecord>()
  constructor(private send: (record: PiRecord) => void, private clock = Date.now) {}
  pause() {
    if (this.paused) return
    this.paused = true
    this.send({type:'desktop_presentation', paused:true})
  }
  resume() {
    if (!this.paused) return
    for (const record of this.pending.values()) this.send(record)
    this.pending.clear()
    this.paused = false
    this.send({type:'desktop_presentation', paused:false})
  }
  push(record: PiRecord) {
    const id = record.desktopSession
    if (!this.paused || !id) return this.send(record)
    // Preserve arrival times before folding deltas; split at stalls. Only the
    // endpoints of an uninterrupted burst are needed by the activity tracker.
    const b = record.assistantMessageEvent
    if (record.type === 'message_update' && /^(text|thinking|toolcall)_delta$/.test(b?.type) && b.delta?.length) {
      const time = this.clock()
      record = {...record, desktopFirstDelta:time, desktopLastDelta:time}
    }
    const old = this.pending.get(id)
    const stream = record.type === 'message_update' || record.type === 'tool_execution_update'
    if (old) {
      const a = old.assistantMessageEvent, b = record.assistantMessageEvent
      if (old.desktopEpoch === record.desktopEpoch && old.type === record.type && stream) {
        if (record.type === 'tool_execution_update' && old.toolCallId === record.toolCallId || record.type === 'message_update' && record.message && !old.desktopLastDelta && !record.desktopFirstDelta) {
          this.pending.set(id,record); return
        }
        if (!old.message && !record.message && typeof a?.delta === 'string' && typeof b?.delta === 'string' && a.type === b.type && a.contentIndex === b.contentIndex && record.desktopFirstDelta-old.desktopLastDelta < 1000) {
          this.pending.set(id,{...record,desktopFirstDelta:old.desktopFirstDelta,assistantMessageEvent:{...b,delta:a.delta+b.delta}}); return
        }
      }
      this.pending.delete(id)
      this.send(old)
    }
    if (stream) this.pending.set(id,record)
    else this.send(record)
  }
}
