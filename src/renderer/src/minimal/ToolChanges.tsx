import { useMemo, useState } from 'react'
import type { ContentBlock, Message } from '../../../../packages/shared/desktop'
import type { ToolState } from './presentation'
import { stripAnsi } from '../../../../packages/shared/ansi'
import { messageText } from './transcript'
import { boundedDiagnostic, contentPreview, parseNativeDiff, previewLimit, type ChangePreview } from './toolChangePreview'
import './toolChanges.css'

function Lines({ preview }: { preview: ChangePreview }) {
  return <>
    <div className="change-lines" aria-label="Numbered content preview">
      {preview.lines.map((line, index) => <div className={`change-line change-${line.kind}`} key={index}>
        <span className="change-number">{line.number}</span>
        <span className="change-sign">{line.kind === 'added' ? '+' : line.kind === 'deleted' ? '−' : ' '}</span>
        <code>{line.text || ' '}</code>
      </div>)}
    </div>
    {preview.truncated && <p>Preview limited to 300 lines, 1,000 characters per line and 30,000 source characters. Full data remains in the native session.</p>}
  </>
}

export function ToolChanges({ call, result, status }: { call: ContentBlock; result?: Message; status: ToolState }) {
  const [raw, setRaw] = useState(false)
  const args = call.arguments && typeof call.arguments === 'object' ? call.arguments as Record<string, unknown> : {}
  const succeeded = status === 'succeeded'
  const diff = useMemo(() => succeeded ? parseNativeDiff(result?.details?.diff) : undefined, [succeeded, result?.details?.diff])
  const content = useMemo(() => typeof args.content === 'string' ? contentPreview(args.content) : undefined, [args.content])
  const oldText = useMemo(() => typeof args.oldText === 'string' ? contentPreview(args.oldText, 'deleted') : undefined, [args.oldText])
  const newText = useMemo(() => typeof args.newText === 'string' ? contentPreview(args.newText) : undefined, [args.newText])
  const replacements = useMemo(() => Array.isArray(args.edits) ? args.edits.slice(0, 5).map(edit => {
    const item = edit && typeof edit === 'object' ? edit as Record<string, unknown> : {}
    return { old: typeof item.oldText === 'string' ? contentPreview(item.oldText, 'deleted') : undefined,
      next: typeof item.newText === 'string' ? contentPreview(item.newText) : undefined }
  }) : [], [args.edits])
  const stateLabel = succeeded ? 'Succeeded' : status === 'failed' ? 'Failed — changes not confirmed' : `Proposed changes — ${status}`
  const output = result ? stripAnsi(messageText(result)).slice(0, previewLimit) : ''
  return <section className="tool-changes" aria-label="File change details">
    <div className="tool-section-label">{stateLabel}</div>
    {typeof args.path === 'string' && <div className="change-path">{args.path.slice(0, 1000)}</div>}
    {status === 'failed' && <pre className="error-text" role="alert">{result?.errorMessage?.slice(0, previewLimit) || output || 'Tool failed. No confirmed change details available.'}</pre>}
    {call.name === 'edit' ? diff ? <>
      <p>Native edit diff — reported by tool</p><Lines preview={diff} />
    </> : <>
      <p>{succeeded ? 'Native diff unavailable. Submitted replacement (not a confirmed diff).' : 'Proposed replacement (not confirmed).'} Line numbers below are relative to each snippet.</p>
      {oldText && <><div className="tool-section-label">Old text</div><Lines preview={oldText} /></>}
      {newText && <><div className="tool-section-label">New text</div><Lines preview={newText} /></>}
      {replacements.map((edit, index) => <div key={index}><div className="tool-section-label">Replacement {index + 1}</div>
        {edit.old && <><div className="tool-section-label">Old text</div><Lines preview={edit.old} /></>}
        {edit.next && <><div className="tool-section-label">New text</div><Lines preview={edit.next} /></>}
      </div>)}
      {Array.isArray(args.edits) && args.edits.length > 5 && <p>Showing the first 5 replacements. Remaining requests are available in diagnostics.</p>}
      {!oldText && !newText && !replacements.length && <p>Replacement content unavailable.</p>}
    </> : <>
      <p>{succeeded ? 'Submitted content — write succeeded.' : 'Proposed write content.'} Previous content unavailable; this is not a diff.</p>
      {content ? <Lines preview={content} /> : <p>Write content unavailable.</p>}
    </>}
    <details onToggle={(event) => setRaw(event.currentTarget.open)}>
      <summary>Raw arguments and result (diagnostics)</summary>
      {raw && <><div className="tool-section-label">Arguments</div><pre>{boundedDiagnostic(call.arguments)}</pre>
        <div className="tool-section-label">Result</div><pre>{result ? boundedDiagnostic(result) : 'No result yet.'}</pre></>}
    </details>
  </section>
}
