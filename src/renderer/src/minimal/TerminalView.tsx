import { useUiText } from './language'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, CornerDownLeft, Eraser, PanelLeft, Terminal as TerminalIcon, X } from 'lucide-react'
import type { TerminalCompletion, TerminalInfo, TerminalTransport } from '../../../../packages/shared/terminal'
import '@xterm/xterm/css/xterm.css'
import './terminal-view.css'

export interface TerminalViewProps {
  info: TerminalInfo
  visible: boolean
  transport: TerminalTransport
  workspaceName?: string
  terminalFontSize?: number | 'auto'
  onFontSizeChange(value: number | 'auto'): void
  toggleSidebar(): void
  onClose(): void
  action?: { id: string; name: 'clear'; sequence: number }
  onError?(error: unknown): void
}
type Terminal = import('@xterm/xterm').Terminal
type FitAddon = import('@xterm/addon-fit').FitAddon
type Candidate = TerminalCompletion['options'][number]
const encoder = new TextEncoder()
const MAX_DRAFT_BYTES = 64 * 1024
const MAX_COMMAND_BYTES = 4096
const signature = (info: TerminalInfo) => `${info.id}:${info.mode}:${info.state}`
function terminalTheme(info: TerminalInfo) {
  const dark = document.documentElement.classList.contains('dark')
  const idle = info.mode === 'command' && info.state === 'ready'
  const foreground = dark ? '#d2d5db' : '#373c43'
  return { background: dark ? '#19191c' : '#fcfcfd', foreground,
    cursor: idle ? 'transparent' : dark ? '#7aaaff' : '#4176e6',
    cursorAccent: idle ? foreground : dark ? '#19191c' : '#fcfcfd',
    selectionBackground: dark ? '#28344b' : '#eaf0fc' }
}

export function TerminalView({ info, visible, transport, workspaceName, terminalFontSize = 'auto', onFontSizeChange, toggleSidebar, onClose, action, onError }: TerminalViewProps) {
  const t = useUiText()
  const root = useRef<HTMLElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const latest = useRef({ info, visible, onError })
  latest.current = { info, visible, onError }
  const [error, setError] = useState('')
  const report = useCallback((value: unknown) => {
    const message = value instanceof Error ? value.message : String(value)
    setError(message)
    latest.current.onError?.(value)
  }, [])
  const [draft, setDraft] = useState('')
  const draftRef = useRef('')
  const history = useRef<string[]>([])
  const historyIndex = useRef<number | null>(null)
  const historyDraft = useRef('')
  const revision = useRef(0)
  const completionPending = useRef(false)
  const pendingCursor = useRef<{ start: number; end: number } | null>(null)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [candidateIndex, setCandidateIndex] = useState(-1)
  const [cursorRequest, setCursorRequest] = useState<{ cursor: number }>()
  const [completing, setCompleting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [modeBusy, setModeBusy] = useState(false)
  const [draftWhileDirect, setDraftWhileDirect] = useState(false)
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 760)
  const automaticSize = narrow ? 14 : 15
  const fontSize = typeof terminalFontSize === 'number' && Number.isFinite(terminalFontSize) ? Math.max(10, Math.min(22, terminalFontSize)) : automaticSize
  const fontRef = useRef(fontSize)
  fontRef.current = fontSize
  const fitFrame = useRef<number | null>(null)
  const lastGrid = useRef('')
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'output' | 'command'; start: number; end: number; selection: string }>()
  const menuNode = useRef<HTMLDivElement>(null)
  const commandMode = info.mode === 'command'
  const editable = commandMode || (draftWhileDirect && info.state === 'running')
  const bytes = encoder.encode(draft).length

  const invalidate = useCallback(() => { revision.current++; pendingCursor.current = null; setCandidates([]); setCandidateIndex(-1) }, [])
  const changeDraft = useCallback((value: string) => {
    if (encoder.encode(value).length > MAX_DRAFT_BYTES) { report(new Error('Command draft exceeds 64 KiB; it was not truncated or submitted')); return }
    draftRef.current = value
    setDraft(value)
    invalidate()
  }, [invalidate, report])
  // Commit the native cursor together with its buffer, never in a later frame
  // that could overwrite a subsequent selection or paste.
  useLayoutEffect(() => {
    if (cursorRequest && input.current) {
      input.current.focus()
      input.current.setSelectionRange(cursorRequest.cursor, cursorRequest.cursor)
    }
  }, [cursorRequest])
  const setSelection = (cursor: number) => setCursorRequest({ cursor })
  const choose = (candidate: Candidate, index: number) => {
    revision.current++
    draftRef.current = candidate.buffer
    setDraft(candidate.buffer)
    setCandidateIndex(index)
    setSelection(candidate.cursor)
  }
  useEffect(() => {
    root.current?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [candidateIndex])
  const refit = useCallback(() => {
    if (fitFrame.current !== null) return
    fitFrame.current = requestAnimationFrame(() => {
      fitFrame.current = null
      if (!latest.current.visible || latest.current.info.state === 'exited' || !host.current?.clientWidth || !host.current.clientHeight || !term.current || !fit.current) return
      try {
        fit.current.fit()
        const grid = `${latest.current.info.id}:${term.current.cols}:${term.current.rows}`
        if (grid !== lastGrid.current) {
          lastGrid.current = grid
          void transport.resize(latest.current.info.id, term.current.cols, term.current.rows).catch(report)
        }
      } catch (error) { report(error) }
    })
  }, [transport, report])
  useEffect(() => {
    const resize = () => { setNarrow(window.innerWidth <= 760); refit() }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [refit])
  useLayoutEffect(() => {
    if (term.current) term.current.options.fontSize = fontSize
    refit()
  }, [fontSize, visible, editable, refit])
  useEffect(() => {
    invalidate()
    setDraftWhileDirect(false)
    if (term.current) {
      term.current.options.disableStdin = info.mode !== 'direct' || info.state === 'exited'
      term.current.options.theme = terminalTheme(info)
    }
  }, [info.mode, info.state, info.id, invalidate])
  useEffect(() => {
    draftRef.current = ''; setDraft(''); history.current = []; historyIndex.current = null; setError('')
  }, [info.id])

  useEffect(() => {
    let disposed = false
    let unsubscribe = () => {}
    let instance: Terminal | undefined
    let observer: ResizeObserver | undefined
    let themeObserver: MutationObserver | undefined
    const queue: Array<{ data: string; epoch: string; reply: boolean }> = []
    let queuedBytes = 0, writing = false
    const id = info.id
    const flush = async () => {
      if (writing || disposed) return
      writing = true
      while (queue.length && !disposed) {
        const item = queue[0]
        if (!item.reply && item.epoch !== signature(latest.current.info)) {
          queuedBytes -= encoder.encode(item.data).length; queue.shift()
          report(new Error('Pending terminal input was discarded after the program or mode changed'))
          continue
        }
        let end = Math.min(4096, item.data.length)
        if (end < item.data.length && /[\uD800-\uDBFF]/.test(item.data[end - 1])) end--
        const chunk = item.data.slice(0, end)
        try { await transport.write(id, chunk) }
        catch (error) {
          queue.length = 0; queuedBytes = 0
          if (!disposed && latest.current.info.state !== 'exited') report(error)
          break
        }
        queuedBytes -= encoder.encode(chunk).length
        item.data = item.data.slice(end)
        if (!item.data) queue.shift()
      }
      writing = false
    }
    const start = async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
        if (disposed || !host.current) return
        instance = new Terminal({ scrollback: 3000, fontFamily: "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace", fontSize: fontRef.current,
          disableStdin: latest.current.info.mode !== 'direct' || latest.current.info.state === 'exited', convertEol: false, cursorBlink: true, cursorInactiveStyle: 'none', allowProposedApi: false })
        const addon = new FitAddon()
        instance.loadAddon(addon)
        instance.open(host.current)
        term.current = instance; fit.current = addon
        instance.attachCustomKeyEventHandler?.((event) => !(event.metaKey && ['=', '+', '-', '0'].includes(event.key)))
        const theme = () => {
          if (!instance) return
          instance.options.theme = terminalTheme(latest.current.info)
        }
        theme()
        themeObserver = new MutationObserver(theme)
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
        instance.onData((data) => {
          if (disposed || latest.current.info.state === 'exited') return
          const reply = isTerminalReply(data)
          // disableStdin blocks command-mode typing, not emulator DSR/DA replies.
          if (latest.current.info.mode !== 'direct' && !reply) return
          const size = encoder.encode(data).length
          if (queuedBytes + size > 65536) { report(new Error('Terminal input buffer is full; this input was not sent')); return }
          queue.push({ data, epoch: signature(latest.current.info), reply }); queuedBytes += size
          void flush()
        })
        unsubscribe = transport.onOutput((packet) => {
          if (packet.id !== id || disposed || !instance) return
          instance.write(packet.data, () => { if (!disposed) void transport.acknowledge(id, packet.sequence).catch(report) })
        })
        if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(refit); observer.observe(host.current) }
        await transport.attach(id)
        if (!disposed) {
          refit()
          if (latest.current.visible && latest.current.info.mode === 'direct' && !document.querySelector('dialog[open], [role="dialog"]') && (!document.activeElement || document.activeElement === document.body || root.current?.contains(document.activeElement))) instance.focus()
        }
      } catch (error) { if (!disposed) report(error) }
    }
    void start()
    return () => {
      disposed = true; revision.current++; pendingCursor.current = null; queue.length = 0; queuedBytes = 0
      unsubscribe(); observer?.disconnect(); themeObserver?.disconnect()
      if (fitFrame.current !== null) { cancelAnimationFrame(fitFrame.current); fitFrame.current = null }
      instance?.dispose()
      if (term.current === instance) { term.current = null; fit.current = null; lastGrid.current = '' }
    }
  }, [info.id, transport, refit, report])
  useEffect(() => { if (action?.id === info.id && action.name === 'clear') term.current?.clear() }, [action?.id, action?.name, action?.sequence, info.id])
  const previouslyVisible = useRef(false)
  useEffect(() => {
    const entering = visible && !previouslyVisible.current
    previouslyVisible.current = visible
    if (!visible || document.querySelector('dialog[open], [role="dialog"]')) return
    const active = document.activeElement
    if (!entering && active !== document.body && active && !root.current?.contains(active)) return
    if (editable) input.current?.focus()
    else if (info.mode === 'direct') term.current?.focus()
  }, [visible, info.mode, info.state, editable])

  const submit = async () => {
    if (busy || completionPending.current || info.state !== 'ready' || !commandMode || !draftRef.current.trim()) return
    if (encoder.encode(draftRef.current).length > MAX_COMMAND_BYTES) { report(new Error('Command exceeds 4096 UTF-8 bytes; shorten it or use direct input')); return }
    const value = draftRef.current
    setBusy(true); invalidate()
    try {
      await transport.submit(info.id, value)
      history.current = [...history.current.slice(-99), value]; historyIndex.current = null
      if (draftRef.current === value) changeDraft('')
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith('Terminal submission cancelled')) report(error)
    } finally { setBusy(false) }
  }
  const switchMode = async () => {
    if (modeBusy || completionPending.current) return
    const target = commandMode ? 'direct' : 'command'
    invalidate(); setModeBusy(true)
    try {
      // Never import program/password input into a separately owned command draft.
      await transport.setMode(info.id, target, target === 'direct' ? draftRef.current : undefined,
        target === 'direct' ? input.current?.selectionStart ?? draftRef.current.length : undefined)
    } catch (error) { report(error) } finally { setModeBusy(false) }
  }
  const complete = async () => {
    if (completionPending.current || busy || !commandMode || info.state !== 'ready') return
    const buffer = draftRef.current
    const start = input.current?.selectionStart ?? buffer.length
    const end = input.current?.selectionEnd ?? start
    const token = ++revision.current
    pendingCursor.current = { start, end }
    completionPending.current = true; setCompleting(true)
    try {
      const result = await transport.complete(info.id, buffer, start)
      if (token !== revision.current || latest.current.info.mode !== 'command' || latest.current.info.state !== 'ready' || input.current?.selectionStart !== start || input.current.selectionEnd !== end) return
      pendingCursor.current = null
      draftRef.current = result.buffer; setDraft(result.buffer)
      setCandidates(result.options); setCandidateIndex(-1)
      setSelection(result.cursor)
    } catch (error) { if (token === revision.current) report(error) }
    finally { completionPending.current = false; setCompleting(false); pendingCursor.current = null }
  }
  const recall = (direction: number) => {
    if (!history.current.length) return
    if (historyIndex.current === null) { if (direction > 0) return; historyDraft.current = draftRef.current; historyIndex.current = history.current.length }
    historyIndex.current = Math.max(0, Math.min(history.current.length, historyIndex.current + direction))
    changeDraft(historyIndex.current === history.current.length ? historyDraft.current : history.current[historyIndex.current])
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'c') {
      event.preventDefault(); historyIndex.current = null; changeDraft('')
      if (busy || info.state === 'running') void transport.interrupt(info.id).catch(report)
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'u') {
      event.preventDefault()
      const start = event.currentTarget.selectionStart, end = event.currentTarget.selectionEnd
      const buffer = draftRef.current
      const lineStart = buffer.slice(0, start).lastIndexOf('\n') + 1
      historyIndex.current = null
      changeDraft(buffer.slice(0, lineStart) + buffer.slice(end))
      setSelection(lineStart)
    } else if (candidates.length && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      const direction = event.key === 'ArrowUp' ? -1 : 1
      setCandidateIndex(candidateIndex < 0 ? (direction > 0 ? 0 : candidates.length - 1) : (candidateIndex + direction + candidates.length) % candidates.length)
    } else if (event.key === 'Escape') invalidate()
    else if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey && commandMode && info.state === 'ready') {
      event.preventDefault()
      if (candidates.length) {
        const next = candidateIndex < 0 ? (event.shiftKey ? candidates.length - 1 : 0) : (candidateIndex + (event.shiftKey ? -1 : 1) + candidates.length) % candidates.length
        choose(candidates[next], next)
      } else void complete()
    } else if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      if (candidates.length) {
        const index = Math.max(0, candidateIndex)
        choose(candidates[index], index); invalidate()
      } else void submit()
    } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && (event.altKey || (!draft.includes('\n') && !event.metaKey && !event.ctrlKey && !event.shiftKey))) {
      event.preventDefault(); recall(event.key === 'ArrowUp' ? -1 : 1)
    } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) invalidate()
  }
  useEffect(() => {
    if (!menu) return
    menuNode.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const close = () => setMenu(undefined)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); if (menu.kind === 'command') input.current?.focus(); else term.current?.focus() } }
    window.addEventListener('pointerdown', close); window.addEventListener('resize', close); window.addEventListener('blur', close); window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('resize', close); window.removeEventListener('blur', close); window.removeEventListener('keydown', key) }
  }, [menu])
  const context = (event: React.MouseEvent, kind: 'output' | 'command') => {
    event.preventDefault()
    const start = input.current?.selectionStart ?? 0, end = input.current?.selectionEnd ?? 0
    setMenu({ kind, start, end, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 208)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 130)),
      selection: kind === 'command' ? draftRef.current.slice(start, end) : term.current?.getSelection() || '' })
  }
  const paste = async () => {
    if (!menu) return
    const target = menu; setMenu(undefined)
    try {
      const text = await transport.pasteText()
      if (target.kind === 'output') {
        if (latest.current.info.mode !== 'direct') throw new Error('Use the command editor to paste a command')
        if (encoder.encode(text).length > 60 * 1024) throw new Error('Terminal paste exceeds 60 KiB; no input was sent')
        term.current?.paste(text); term.current?.focus()
      } else {
        const value = draftRef.current.slice(0, target.start) + text + draftRef.current.slice(target.end)
        changeDraft(value); setSelection(target.start + text.length)
      }
    } catch (error) { report(error) }
  }
  const title = workspaceName || info.workspace.split('/').filter(Boolean).at(-1) || info.workspace
  return <section ref={root} className="terminal-view" hidden={!visible} aria-label={`Terminal ${info.name}`}>
    <header className="topbar terminal-view__header">
      <button className="icon-button" onClick={toggleSidebar} aria-label={t("Toggle sidebar")} title={t("Toggle sidebar")}><PanelLeft size={18} /></button>
      <div className="breadcrumbs"><span>{title}</span><ChevronRight size={12} /><strong title={info.name}>{info.name}</strong></div>
      <div className="header-actions terminal-view__header-actions">
        <div className="terminal-font-control" role="group" aria-label={t("Terminal font size")}>
          <button aria-label={t("Decrease terminal font size")} disabled={fontSize <= 10} onClick={() => onFontSizeChange(fontSize - 1)}>{t("A−")}</button>
          <button aria-label={t("Increase terminal font size")} disabled={fontSize >= 22} onClick={() => onFontSizeChange(fontSize + 1)}>{t("A+")}</button>
        </div>
        <span className="terminal-shell-badge">{info.shell.split('/').at(-1)}</span>
        <button className="icon-button" aria-label={t("Clear terminal output")} title={t("Clear output")} onClick={() => term.current?.clear()}><Eraser size={15} /></button>
        <button className="icon-button" aria-label={t("Close terminal")} title={t("Close terminal")} onClick={onClose}><X size={15} /></button>
      </div>
    </header>
    {(error || info.reason) && <div role={error ? 'alert' : 'status'} className={`banner ${error ? 'error' : ''}`}><span>{error || info.reason}</span>{error && <button className="icon-button" aria-label={t("Dismiss terminal error")} onClick={() => setError('')}><X size={14} /></button>}</div>}
    <div className="terminal-view__body" style={{ fontSize }}>
      <div className="terminal-view__output" onContextMenu={(event) => context(event, 'output')}><div ref={host} className="terminal-view__xterm" aria-label={t("Terminal output")} /></div>
      <div className={`terminal-view__shelf ${editable ? '' : 'is-direct'}`}>
        <div className="terminal-view__identity"><TerminalIcon size={15} /><strong>{editable ? t('COMMAND') : t('DIRECT')}</strong><small>{info.shell.split('/').at(-1)}</small></div>
        <div className="terminal-view__editor">
          <div className="terminal-view__context"><span title={info.cwd}>{info.cwd}</span><span className={`terminal-view__state ${info.state === 'ready' ? 'is-ready' : info.state === 'running' ? 'is-running' : ''}`}>{completing ? t('Completing…') : t(info.state)}</span></div>
          {editable ? <textarea ref={input} aria-label={t("Terminal command")} disabled={modeBusy || info.state === 'exited'} value={draft}
            placeholder={commandMode ? t('Type a command…') : t('Draft only — not sent to the running program')} rows={2} spellCheck={false}
            onChange={(event) => { historyIndex.current = null; changeDraft(event.target.value) }} onKeyDown={onKeyDown}
            onSelect={(event) => { const cursor = pendingCursor.current; if (cursor && (event.currentTarget.selectionStart !== cursor.start || event.currentTarget.selectionEnd !== cursor.end)) invalidate() }}
            onContextMenu={(event) => context(event, 'command')}
            onPaste={(event) => { const start = event.currentTarget.selectionStart, end = event.currentTarget.selectionEnd; const next = draft.slice(0, start) + event.clipboardData.getData('text') + draft.slice(end); if (encoder.encode(next).length > MAX_DRAFT_BYTES) { event.preventDefault(); report(new Error('Paste exceeds the 64 KiB draft limit; no text was inserted')) } }} />
            : <p className="terminal-view__direct">{info.state === 'exited' ? t('Shell exited. Close this terminal to discard its output.') : t('Keyboard input goes directly to the terminal. Click the output area to interact.')}</p>}
          {candidates.length > 0 && editable && <div role="listbox" aria-label={t("Native completions")} className="terminal-view__completions">{candidates.map((candidate, index) => <button type="button" role="option" tabIndex={-1} aria-selected={index === candidateIndex} key={index} onMouseDown={(event) => event.preventDefault()} onClick={() => { choose(candidate, index); invalidate() }}>{candidate.label ?? candidate.buffer}</button>)}</div>}
          <div className="terminal-view__actions"><span className="terminal-view__hints">{editable ? (commandMode ? (candidates.length ? t('↑↓ Select · ↵ Accept · Esc Dismiss') : t('↵ Run · ⇧↵ New line · Tab Complete · ⌃U Erase · ⌃C Cancel')) : t('Draft only · no automatic queue')) : t('Native interactive input')}{editable && bytes > MAX_COMMAND_BYTES && <span className="error-text"> · {bytes}{t("/4096 bytes")}</span>}</span>
            {!commandMode && info.state === 'running' && <button onClick={() => setDraftWhileDirect((value) => !value)}>{draftWhileDirect ? t('Hide draft') : t('Draft next command')}</button>}
            {info.state === 'ready' && <button disabled={modeBusy || completing || busy} onClick={() => void switchMode()}>{commandMode ? t('Direct mode') : t('Command mode')}</button>}
            {info.state === 'running' && <button className="error-text" onClick={() => void transport.interrupt(info.id).catch(report)}>{t("Stop")}</button>}
            {editable && <button className="terminal-run" onClick={() => void submit()} disabled={busy || completing || !commandMode || info.state !== 'ready' || !draft.trim() || bytes > MAX_COMMAND_BYTES}>{t("Run") + ' '}<CornerDownLeft size={12} /></button>}
          </div>
        </div>
      </div>
      <footer className="terminal-view__status"><span><i />{t("Local session") + ' '}<span>·</span> {info.state === 'exited' ? `Exited ${info.exitCode ?? ''}` : t('Temporary until App quit')}</span><span>{info.shell.split('/').at(-1)}{' ' + t("· UTF-8")}</span></footer>
    </div>
    {menu && <div ref={menuNode} className="menu terminal-output-menu" role="menu" aria-label={t("Terminal text actions")} style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
      <button role="menuitem" disabled={!menu.selection} onClick={() => { const text = menu.selection; setMenu(undefined); void transport.copyText(text).catch(report) }}>{t("Copy")}</button>
      <button role="menuitem" disabled={info.state === 'exited' || (menu.kind === 'output' && (commandMode || modeBusy))} onClick={() => void paste()}>{t("Paste")}</button>
      <button role="menuitem" onClick={() => { if (menu.kind === 'command') input.current?.select(); else term.current?.selectAll(); setMenu(undefined) }}>{t("Select all")}</button>
    </div>}
  </section>
}

// The same narrow reply predicate is checked again by the main-process transport.
function isTerminalReply(data: string) {
  return /^(?:\x1b\[[0-?]*[ -/]*[cnRyt]|\x1b\[\?[0-9;:]*u|\x1b\][0-9]+;[^\x00-\x1f\x7f]*(?:\x07|\x1b\\)|\x1bP[^\x00-\x1f\x7f]*\x1b\\)+$/.test(data)
}
