import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ShieldQuestion, BookOpen, Folder, X, Maximize2 } from 'lucide-react'
import type { PiRecord } from '../../../../packages/shared/desktop'
import { stripAnsi } from '../../../../packages/shared/ansi'
import './interaction-overlays.css'

export function ExtensionDialog({
  request,
  context,
  workspace,
  sessionTitle,
  answer,
  active = true,
  reading = false,
  onReadingChange,
}: {
  request: PiRecord
  context: string
  workspace?: string
  sessionTitle?: string
  answer: (fields: Record<string, unknown>) => void
  active?: boolean
  reading?: boolean
  onReadingChange?: (reading: boolean) => void
}) {
  const [value, setValue] = useState(request.prefill || '')
  const [selected, setSelected] = useState<number>()
  const [detail, setDetail] = useState<string>()
  const form = useRef<HTMLFormElement>(null)
  const inspector = useRef<HTMLDivElement>(null)
  const inspectOrigin = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()
  const title = stripAnsi(request.title || 'Extension request')
  const message = stripAnsi(request.message || '')
  const options: string[] = Array.isArray(request.options) ? request.options : []
  const kinds: Record<string, string> = {
    select: 'Selection',
    confirm: 'Confirmation',
    input: 'Text input',
    editor: 'Editor',
  }
  const kind = kinds[request.method] || 'Extension request'
  const focusable = (root: HTMLElement) =>
    [
      ...root.querySelectorAll<HTMLElement>(
        'button:not(:disabled),input:not(:disabled),textarea,select,a[href],[tabindex="0"]',
      ),
    ].filter((el) => !el.closest('[hidden]'))

  // The session owns expiry, even when this sheet is reading/hidden. Keep this
  // component mounted so drafts, selection and native DOM scroll survive switches.
  useLayoutEffect(() => {
    if (!active) return
    if (reading) {
      form.current
        ?.closest('.session-view')
        ?.querySelector<HTMLElement>('.conversation')
        ?.focus({ preventScroll: true })
      return
    }
    const root = detail !== undefined ? inspector.current : form.current
    if (!root) return
    const previous = document.activeElement as HTMLElement | null
    const target =
      detail !== undefined
        ? root.querySelector<HTMLElement>('[aria-label="Close full text"]')
        : inspectOrigin.current || root.querySelector<HTMLElement>('textarea, [aria-label="Dismiss request"]')
    target?.focus({ preventScroll: true })
    return () => {
      if (root.contains(document.activeElement) && previous?.isConnected && !previous.closest('[hidden]'))
        previous.focus({ preventScroll: true })
    }
  }, [active, reading, detail !== undefined])

  const closeDetail = () => {
    setDetail(undefined)
  }
  const inspect = (text: string, label: string) => (
    <button
      type="button"
      className="request-inspect icon-button"
      aria-label={`Read full ${label}`}
      onClick={(event) => {
        inspectOrigin.current = event.currentTarget
        setDetail(text)
      }}
    >
      <Maximize2 size={14} />
    </button>
  )
  return (
    <div className="modal-shade review-shade" hidden={!active || reading}>
      <form
        ref={form}
        className="dialog review-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDownCapture={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            if (detail !== undefined) closeDetail()
            else answer({ cancelled: true })
          }
          if (event.key === 'Tab') {
            const root = detail !== undefined ? inspector.current : form.current
            if (!root) return
            const items = focusable(root),
              first = items[0],
              last = items.at(-1)
            if (
              event.shiftKey &&
              (document.activeElement === first || !root.contains(document.activeElement))
            ) {
              event.preventDefault()
              last?.focus()
            } else if (
              !event.shiftKey &&
              (document.activeElement === last || !root.contains(document.activeElement))
            ) {
              event.preventDefault()
              first?.focus()
            }
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (reading || !active || detail !== undefined) return
          if (request.method === 'select') {
            if (selected !== undefined && options[selected] !== undefined)
              answer({ value: options[selected] })
          } else answer(request.method === 'confirm' ? { confirmed: true } : { value })
        }}
      >
        <div className="review-layout">
          <aside className="review-sidebar">
            <div className="review-symbol">
              <ShieldQuestion size={21} />
            </div>
            <h3>Request review</h3>
            <p>A decision for this session.</p>
            <dl>
              <div>
                <dt>WORKSPACE</dt>
                <dd title={workspace || context}>{workspace || context}</dd>
              </div>
              {sessionTitle && (
                <div>
                  <dt>SESSION</dt>
                  <dd title={sessionTitle}>{sessionTitle}</dd>
                </div>
              )}
              <div>
                <dt>INTERFACE</dt>
                <dd>Pi extension</dd>
              </div>
              <div>
                <dt>REQUEST TYPE</dt>
                <dd>{kind}</dd>
              </div>
            </dl>
          </aside>
          <div className="review-main">
            <header className="review-header">
              <div className="review-owner">
                <Folder size={13} />
                <span title={context}>{context}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Dismiss request"
                  onClick={() => answer({ cancelled: true })}
                >
                  <X size={17} />
                </button>
              </div>
              <div className="review-eyebrow">
                <ShieldQuestion size={14} />
                Response requested
              </div>
              <div className="review-title">
                <h2 id={titleId}>
                  {title.slice(0, 180)}
                  {title.length > 180 ? '…' : ''}
                </h2>
                {inspect(title, 'request title')}
              </div>
            </header>
            <div className="review-body">
              {message && (
                <div className="review-message">
                  <header>
                    <span>Request details</span>
                    {inspect(message, 'request message')}
                  </header>
                  <pre>
                    {message.slice(0, 360)}
                    {message.length > 360 ? '…' : ''}
                  </pre>
                </div>
              )}
              {request.method === 'select' ? (
                <fieldset className="review-options">
                  <legend>Choose a response</legend>
                  {options.map((option, index) => {
                    const text = stripAnsi(option)
                    return (
                      <div className="review-option" key={`${index}:${option}`}>
                        <label>
                          <input
                            type="radio"
                            name={`response-${request.id}`}
                            checked={selected === index}
                            onChange={() => setSelected(index)}
                            aria-label={text}
                          />
                          <span>
                            {text.slice(0, 180)}
                            {text.length > 180 ? '…' : ''}
                          </span>
                        </label>
                        {inspect(text, `option ${index + 1}`)}
                      </div>
                    )
                  })}
                </fieldset>
              ) : (
                request.method !== 'confirm' && (
                  <textarea
                    aria-label={title}
                    rows={request.method === 'editor' ? 8 : 3}
                    placeholder={request.placeholder}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                  />
                )
              )}
            </div>
          </div>
        </div>
        <footer className="review-actions">
          {onReadingChange && (
            <button type="button" className="review-context-button" onClick={() => onReadingChange(true)}>
              <BookOpen size={15} />
              View conversation
            </button>
          )}
          <button type="button" onClick={() => answer({ cancelled: true })}>
            Cancel
          </button>
          <button
            className="primary"
            type="submit"
            disabled={request.method === 'select' && selected === undefined}
          >
            {request.method === 'confirm' ? 'Confirm' : request.method === 'select' ? 'Continue' : 'Submit'}
          </button>
        </footer>
        {detail !== undefined && (
          <div ref={inspector} className="request-detail" role="region" aria-label="Full request text">
            <header>
              <strong>Full request text</strong>
              <button
                type="button"
                className="icon-button"
                aria-label="Close full text"
                onClick={closeDetail}
              >
                <X size={15} />
              </button>
            </header>
            <pre tabIndex={0}>{detail}</pre>
            <footer>Complete extension text. Escape returns to the request.</footer>
          </div>
        )}
      </form>
    </div>
  )
}
