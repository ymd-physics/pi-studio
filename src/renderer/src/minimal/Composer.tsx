import { useUiText } from './language'
import { useEffect, useState, type RefObject } from 'react'
import { ArrowUp, Square, Paperclip, X, FileText } from 'lucide-react'
import { TodoButton } from './TodoButton'
import { ContextMeter } from './ContextMeter'
import { CodexQuota } from './CodexQuota'
import { supportsCodexFeatures } from '../../../../packages/shared/codex-model'
import type { CodexUsageSnapshot } from '../../../../packages/shared/codex-usage'
import './ComposerFooter.css'
import type { Attachment, AttachmentInput } from '../../../../packages/shared/assets'
import type { Command, Snapshot } from '../../../../packages/shared/desktop'

interface Props {
  session: Snapshot
  usage?: CodexUsageSnapshot
  draft: string
  setDraft: (text: string) => void
  inputRef: RefObject<HTMLTextAreaElement>
  commands: Command[]
  refreshCommands?: () => void
  busy: boolean
  loading: boolean
  sending?: boolean
  attachments?: Attachment[]
  attach?: (inputs?: AttachmentInput[]) => Promise<boolean>
  removeAttachment?: (id: string) => Promise<void>
  enterToSend: boolean
  widgets: Record<string, string>
  statuses: Record<string, string>
  send: (mode?: 'steer' | 'followUp') => Promise<void>
  stop: () => Promise<void>
  run: (type: string, args?: Record<string, unknown>) => Promise<unknown>
}

/** Presentation/input behavior only; Pi command and session ownership stay in App/main. */
export function Composer({
  session,
  usage,
  draft,
  setDraft,
  inputRef,
  commands,
  refreshCommands,
  busy,
  loading,
  sending,
  attachments = [],
  attach,
  removeAttachment,
  enterToSend,
  widgets,
  statuses,
  send,
  stop,
  run,
}: Props) {
  const t = useUiText()
  const [suggestion, setSuggestion] = useState(0)
  const [dragging, setDragging] = useState(false)
  const attachFiles = async (files: File[]) => {
    if (!attach || loading || sending) return
    const inputs: AttachmentInput[] = []
    for (const file of files) {
      const path = window.desktop.pathForFile(file)
      if (path) inputs.push({ path })
      else if (file.size <= 32 * 1024 * 1024)
        inputs.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
      else {
        alert('Attachment exceeds 32 MiB')
        return
      }
    }
    if (inputs.length) await attach(inputs)
  }
  const slash = /^\/([^\s]*)$/.exec(draft)
  const suggestions = slash
    ? commands.filter((c) => c.name.toLowerCase().startsWith(slash[1].toLowerCase()))
    : []
  const activeCommand = /^\/(\S+)\s/.exec(draft)?.[1]
  const context = commands.find((c) => c.name === activeCommand)
  const locked = busy || loading
  const hasSlash = draft.startsWith('/')
  useEffect(() => {
    if (hasSlash && !loading) refreshCommands?.()
  }, [hasSlash, loading])
  useEffect(() => {
    document.querySelector('.command-list [aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [suggestion])
  useEffect(() => {
    const el = inputRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(240, el.scrollHeight)}px`
    }
    setSuggestion(0)
  }, [draft, inputRef])

  return (
    <>
      <div className="extension-widgets">
        {Object.entries(widgets)
          .filter(([, text]) => text)
          .map(([key, text]) => (
            <details key={key}>
              <summary>{key}</summary>
              <pre>{text}</pre>
            </details>
          ))}
      </div>
      <div
        className={`composer-card ${dragging ? 'drag-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void attachFiles(Array.from(e.dataTransfer.files))
        }}
      >
        {!!attachments.length && (
          <div className="attachment-list" aria-label={t("Draft attachments")}>
            {attachments.map((a) => (
              <div className="attachment-chip" key={a.id}>
                {a.preview ? <img src={a.preview} alt={a.name} /> : <FileText size={22} />}
                <span title={a.path}>
                  {a.name}
                  <small>{Math.max(1, Math.round(a.size / 1024))}{' ' + t("KB")}</small>
                </span>
                <button
                  type="button"
                  disabled={loading || sending}
                  aria-label={t('Remove attachment {name}', { name: a.name })}
                  onClick={() => void removeAttachment?.(a.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {suggestions.length > 0 && (
          <div className="command-list" role="listbox" aria-label={t("Slash commands")}>
            {suggestions.map((command, i) => (
              <button
                key={command.name}
                role="option"
                aria-selected={i === suggestion}
                className={i === suggestion ? 'selected' : ''}
                onClick={() => {
                  setDraft(`/${command.name} `)
                  inputRef.current?.focus()
                }}
              >
                <strong>/{command.name}</strong>
                <span>{command.source === 'desktop' ? t(command.description || command.source) : command.description || command.source}</span>
              </button>
            ))}
          </div>
        )}
        {context && (
          <div className="command-context" role="note">
            <strong>/{context.name}</strong> — {context.description || context.source}
          </div>
        )}
        <textarea
          ref={inputRef}
          onFocus={() => {
            if (hasSlash && !loading) refreshCommands?.()
          }}
          aria-label={t("Message Pi")}
          placeholder={t("Ask anything, or / for commands")}
          rows={2}
          value={draft}
          disabled={loading}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            if (!attach || loading || sending) return
            e.preventDefault()
            const text = e.clipboardData.getData('text/plain')
            const input = e.currentTarget
            const start = input.selectionStart,
              end = input.selectionEnd
            const before = input.value
            void attach().then((handled) => {
              if (!handled && text) {
                setDraft(before.slice(0, start) + text + before.slice(end))
                requestAnimationFrame(() => {
                  input.focus()
                  input.setSelectionRange(start + text.length, start + text.length)
                })
              }
            })
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (suggestions.length && ['ArrowDown', 'ArrowUp', 'Tab'].includes(e.key)) {
              e.preventDefault()
              if (e.key === 'Tab') setDraft(`/${suggestions[suggestion]?.name || suggestions[0].name} `)
              else
                setSuggestion(
                  (i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length,
                )
              return
            }
            if (e.key === 'Enter' && !e.shiftKey && (enterToSend || e.metaKey || e.ctrlKey || e.altKey)) {
              e.preventDefault()
              if (suggestions.length && !commands.some((c) => `/${c.name}` === draft))
                setDraft(`/${suggestions[suggestion]?.name || suggestions[0].name} `)
              else void send(e.altKey ? 'followUp' : 'steer')
            }
          }}
        />
        <div className="composer-controls">
          <div className="model-controls">
            <select
              aria-label={t("Model")}
              disabled={locked}
              value={session.state.model ? `${session.state.model.provider}/${session.state.model.id}` : ''}
              onChange={(e) => {
                const model = session.models.find((m) => `${m.provider}/${m.id}` === e.target.value)
                if (model) void run('set_model', { provider: model.provider, modelId: model.id })
              }}
            >
              {!session.state.model && <option value="">{t("Select a model")}</option>}
              {session.state.model &&
                !session.models.some(
                  (m) => m.id === session.state.model?.id && m.provider === session.state.model.provider,
                ) && (
                  <option value={`${session.state.model.provider}/${session.state.model.id}`}>
                    {session.state.model.id}
                  </option>
                )}
              {session.models.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {m.name || m.id} · {m.provider}
                </option>
              ))}
            </select>
            <select
              aria-label={t("Thinking level")}
              disabled={locked || !session.levels.length}
              value={session.state.thinkingLevel || 'off'}
              onChange={(e) => void run('set_thinking_level', { level: e.target.value })}
            >
              {(session.levels.length ? session.levels : [session.state.thinkingLevel || 'off']).map(
                (level) => (
                  <option key={level} value={level}>{t("Thinking:")} {t(level)}
                  </option>
                ),
              )}
            </select>
            {session.todo?.availability === 'enabled' && <TodoButton state={session.todo} />}
          </div>
          <div className="send-controls">
            <ContextMeter usage={session.contextUsage} />
            {attach && (
              <label className="attach-button" title={t("Attach files")}>
                <Paperclip size={16} />
                <input
                  type="file"
                  multiple
                  aria-label={t("Attach files")}
                  disabled={loading || sending}
                  onChange={(e) => {
                    void attachFiles(Array.from(e.target.files || []))
                    e.target.value = ''
                  }}
                />
              </label>
            )}
            {busy && (
              <button
                className="send-button stop-button"
                aria-label={t("Stop generation")}
                title={t("Stop generation")}
                onClick={() => void stop()}
              >
                <Square size={14} fill="currentColor" />
              </button>
            )}
            <button
              className="send-button"
              aria-label={busy ? t('Send steering message') : t('Send message')}
              title={busy ? t('Send steering message') : t('Send message')}
              disabled={(!draft.trim() && !attachments.length) || loading || sending}
              onClick={() => void send()}
            >
              <ArrowUp size={20} />
            </button>
          </div>
        </div>
      </div>
      <div className="composer-footer" role="group" aria-label={t("Allowance and keyboard shortcuts")}>
        <div className="composer-footer-left">
          {supportsCodexFeatures(session.state.model) && <CodexQuota usage={usage} />}
          {Object.values(statuses).some(Boolean) && (
            <span className="composer-status">{Object.values(statuses).filter(Boolean).join(' · ')}</span>
          )}
        </div>
        <span className="composer-shortcuts">
          {busy
            ? t('↵ Steer · ⌥↵ Follow-up · ⇧↵ New line · Esc Stop')
            : enterToSend
              ? t('↵ Send · ⇧↵ New line')
              : t('⌘/Ctrl ↵ Send')}
        </span>
      </div>
    </>
  )
}
