import { useUiText } from './language'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Files as FilesIcon, PanelLeft, ChevronRight, X, MessageCircleMore } from 'lucide-react'
import type { PiRecord, Preferences, Snapshot } from '../../../../packages/shared/desktop'
import { stripAnsi } from '../../../../packages/shared/ansi'
import { ActivityTracker, emptyActivity } from './activity'
import { EventBatch } from './event-batch'
import { noticeAnchor, withNotices, type SessionNotice } from './notices'
import { applyMessageEvent, messageText } from './transcript'
import { commandCatalog, routeCommand, terminalCommands } from './commands'
import { Conversation } from './Conversation'
import { splitAttachmentBlock, visibleMessageText } from './attachments'
import { CompactionNotice } from './CompactionNotice'
import { Composer } from './Composer'
import { SubagentFocusCard } from './SubagentFocusCard'
import { requestForAgent, type SupervisorRequest } from './subagent-notices'
import { ExtensionDialog } from './ExtensionDialog'
import { MarkdownOrigin } from './MarkdownLinks'
import { projectTodos } from '../../../../packages/shared/todo-state'
import type { Attachment, AttachmentInput } from '../../../../packages/shared/assets'
import type { CodexUsageSnapshot } from '../../../../packages/shared/codex-usage'
import { supportsCodexFeatures } from '../../../../packages/shared/codex-model'

export type SessionAction = { handle: string; name: string; sequence: number }
export function SessionView({
  initial,
  visible,
  navigationPending = false,
  externalNotice,
  preferences,
  usage,
  action,
  toggleSidebar,
  showSidebar,
  toggleFiles,
  filesOpen,
  navigate,
  changed,
  attention,
}: {
  initial: Snapshot
  visible: boolean
  navigationPending?: boolean
  externalNotice?: { id: number; text: string; level: 'info' | 'error' }
  preferences: Preferences
  usage?: CodexUsageSnapshot
  action?: SessionAction
  toggleSidebar: () => void
  showSidebar?: () => void
  toggleFiles: () => void
  filesOpen: boolean
  navigate: (workspace: string, path?: string) => Promise<void>
  changed: (snapshot: Snapshot) => void
  attention: (handle: string, pendingRequests: number) => void
}) {
  const t = useUiText()
  const handle = initial.handle
  const markdownOrigin = useMemo(() => ({ handle }), [handle])
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const [session, setSession] = useState(initial)
  const [subagents, setSubagents] = useState(initial.subagents)
  const subagentRevision = useRef(0)
  const [draft, setDraft] = useState('')
  const [requestNavigation, setRequestNavigation] = useState<{ requestId: string; sequence: number }>()
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attaching, setAttaching] = useState(false)
  const attachmentOperation = useRef(false)
  const attach = async (inputs?: AttachmentInput[]) => {
    if (attachmentOperation.current || submitting.current) return false
    attachmentOperation.current = true
    setAttaching(true)
    try {
      const added = inputs
        ? await window.desktop.importAttachments(handle, inputs)
        : await window.desktop.pasteAttachments(handle)
      if (alive.current) setAttachments((old) => [...old, ...added])
      return added.length > 0
    } catch (e) {
      showError(e)
      return true
    } finally {
      attachmentOperation.current = false
      setAttaching(false)
    }
  }
  const removeAttachment = async (id: string) => {
    if (attachmentOperation.current || submitting.current) return
    attachmentOperation.current = true
    setAttaching(true)
    try {
      await window.desktop.discardAttachment(handle, id)
      setAttachments((old) => old.filter((a) => a.id !== id))
    } catch (e) {
      showError(e)
    } finally {
      attachmentOperation.current = false
      setAttaching(false)
    }
  }
  const [busy, setBusy] = useState(!!(initial.state.isStreaming || initial.state.isCompacting))
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [queued, setQueued] = useState(initial.queued || { steering: [], followUp: [] })
  const todoSequence = useRef(0)
  const refreshVisibleTodo = useRef(() => {})
  const sessionRef = useRef(session)
  sessionRef.current = session
  const [notices, setNotices] = useState<SessionNotice[]>([])
  const noticeId = useRef(Date.now())
  const latestMessage = useRef(initial.messages.at(-1))
  const addNotice = useCallback((text: string, level: SessionNotice['level'] = 'info', key?: string) => {
    if (!text.trim()) return
    const item: SessionNotice = {
      id: ++noticeId.current,
      text,
      level,
      key,
      after: noticeAnchor(latestMessage.current),
    }
    setNotices((old) =>
      key && old.some((n) => n.key === key)
        ? old.map((n) => (n.key === key ? { ...n, text, level } : n))
        : [...old, item],
    )
  }, [])
  const setError = useCallback((text: string) => addNotice(text, 'error'), [addNotice])
  const setNotice = useCallback((text: string) => addNotice(text), [addNotice])
  const displayedMessages = useMemo(() => withNotices(session.messages, notices), [session.messages, notices])
  useEffect(() => {
    if (externalNotice) addNotice(externalNotice.text, externalNotice.level)
  }, [externalNotice?.id])
  const [extensionTitle, setExtensionTitle] = useState('Pi Studio')
  const lastFile = useRef(initial.state.sessionFile)
  const [dialogs, setDialogs] = useState<PiRecord[]>([])
  const [readingRequest, setReadingRequest] = useState<string>()
  const reading = !!dialogs[0] && readingRequest === dialogs[0].id
  const viewRoot = useRef<HTMLElement>(null)
  const readingPosition = useRef<{ id: string; top: number }>()
  const setReading = (next: boolean) => {
    const id = dialogs[0]?.id
    if (!id) return
    const scroll = viewRoot.current?.querySelector<HTMLElement>('.conversation')
    if (!next && scroll) readingPosition.current = { id, top: scroll.scrollTop }
    setReadingRequest(next ? id : undefined)
  }
  useEffect(() => {
    const position = readingPosition.current
    if (visible && reading && position && position.id === dialogs[0]?.id) {
      const scroll = viewRoot.current?.querySelector<HTMLElement>('.conversation')
      if (scroll) scroll.scrollTop = position.top
    }
  }, [visible, reading, dialogs[0]?.id])
  const [widgets, setWidgets] = useState<Record<string, string>>({})
  const [statuses, setStatuses] = useState<Record<string, string>>({})
  const [branches, setBranches] = useState<{ entryId: string; text: string }[]>()
  const [tree, setTree] = useState<any[]>()
  const [rename, setRename] = useState<string>()
  const tracker = useRef(new ActivityTracker())
  const [activity, setActivity] = useState(emptyActivity)
  const composer = useRef<HTMLTextAreaElement>(null)
  const draftSubagentGuidance = (request: SupervisorRequest) => {
    // No tool call, approval or automatic send; preserve an existing draft.
    setDraft(old => old || `Regarding ${request.agent}'s request (${request.requestId}):\n`)
    composer.current?.focus()
  }
  useEffect(() => {
    if (
      !visible ||
      navigationPending ||
      loading ||
      reading ||
      dialogs.length ||
      rename !== undefined ||
      branches ||
      tree
    )
      return
    if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return
    const focus = () => composer.current?.focus({ preventScroll: true })
    if (document.hasFocus()) {
      focus()
      return
    }
    // The window may still be opening; focus the composer once it does, without
    // stealing focus from a control the user clicked first.
    window.addEventListener('focus', focus, { once: true })
    return () => window.removeEventListener('focus', focus)
  }, [visible, navigationPending, loading, reading, dialogs.length, rename, branches, tree])
  const submitting = useRef(false)
  const stopping = useRef(false)
  const dispatchRevision = useRef(0)
  const alive = useRef(true)
  const answered = useRef(new Set<string>())
  const uiRevision = useRef(0)
  const streamRevision = useRef(0)
  const runRevision = useRef(0)
  const syncSequence = useRef(0)
  const contextSequence = useRef(0)
  const refreshContext = useCallback(async () => {
    const sequence = ++contextSequence.current
    const stats = await window.desktop.command('get_session_stats', {}, handle)
    if (alive.current && sequence === contextSequence.current)
      setSession((old) => ({ ...old, contextUsage: stats?.contextUsage }))
  }, [handle])
  const restoreUI = useCallback((snapshot: Snapshot) => {
    const records = snapshot.ui || []
    setDialogs(
      records.filter(
        (r) => ['select', 'confirm', 'input', 'editor'].includes(r.method) && !answered.current.has(r.id),
      ),
    )
    setStatuses(
      Object.fromEntries(
        records
          .filter((r) => r.method === 'setStatus')
          .map((r) => [r.statusKey, stripAnsi(r.statusText || '')]),
      ),
    )
    setWidgets(
      Object.fromEntries(
        records
          .filter((r) => r.method === 'setWidget')
          .map((r) => [r.widgetKey, stripAnsi(r.widgetLines?.join('\n') || '')]),
      ),
    )
  }, [])
  const showError = useCallback(
    (e: unknown) =>
      setError(String(e).replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, '')),
    [],
  )
  const command = useCallback(
    async (type: string, args?: Record<string, unknown>) => {
      const compactCommand =
        type === 'compact' || (type === 'prompt' && /^\/compact(?:\s|$)/.test(String(args?.message || '')))
      if (compactCommand) setActivity(tracker.current.handle({ type: 'desktop_compaction_command_start' }))
      try {
        const result = await window.desktop.command(type, args, handle)
        if (compactCommand)
          setActivity(
            tracker.current.handle({
              type: 'desktop_compaction_command_end',
              result: type === 'compact' ? result : undefined,
            }),
          )
        return result
      } catch (error) {
        if (compactCommand)
          setActivity(
            tracker.current.handle({ type: 'desktop_compaction_command_end', error: String(error) }),
          )
        throw error
      }
    },
    [handle],
  )
  const sync = useCallback(async () => {
    const subagentsAtRequest = subagentRevision.current
    const uiAtRequest = uiRevision.current,
      streamAtRequest = streamRevision.current,
      runAtRequest = runRevision.current,
      contextAtRequest = ++contextSequence.current,
      todoAtRequest = ++todoSequence.current
    const sequence = ++syncSequence.current
    const next = await window.desktop.snapshot(handle)
    if (!alive.current || sequence !== syncSequence.current) return
    if (lastFile.current !== next.state.sessionFile) {
      lastFile.current = next.state.sessionFile
      setNotices([])
      latestMessage.current = next.messages.at(-1)
      setActivity(tracker.current.reset())
    }
    if (subagentsAtRequest === subagentRevision.current) setSubagents(next.subagents)
    const streamUnchanged = streamAtRequest === streamRevision.current
    setSession((old) => ({
      ...next,
      messages: streamUnchanged ? next.messages : old.messages,
      contextUsage: contextAtRequest === contextSequence.current ? next.contextUsage : old.contextUsage,
      todo: todoAtRequest === todoSequence.current ? next.todo : old.todo,
    }))
    // A handled extension may append messages without starting an agent run.
    // Message batching must not prevent its authoritative idle state from applying.
    if (runAtRequest === runRevision.current) setBusy(!!(next.state.isStreaming || next.state.isCompacting))
    if (uiAtRequest === uiRevision.current) restoreUI(next)
    changed(next)
  }, [handle, changed, restoreUI])
  useEffect(() => {
    alive.current = true
    const ui = (event: PiRecord) => {
      uiRevision.current++
      if (['select', 'confirm', 'input', 'editor'].includes(event.method))
        setDialogs((queue) =>
          queue.some((r) => r.id === event.id)
            ? queue
            : [
                ...queue,
                { ...event, desktopExpiresAt: event.desktopExpiresAt ?? Date.now() + (event.timeout || 0) },
              ],
        )
      if (event.method === 'notify')
        addNotice(
          stripAnsi(event.message || ''),
          event.notifyType === 'error' ? 'error' : event.notifyType === 'warning' ? 'warning' : 'info',
        )
      if (event.method === 'set_editor_text') setDraft(event.text || '')
      if (event.method === 'setTitle') setExtensionTitle(stripAnsi(event.title || 'Pi Studio'))
      if (event.method === 'setStatus')
        setStatuses((values) => ({ ...values, [event.statusKey]: stripAnsi(event.statusText || '') }))
      if (event.method === 'setWidget')
        setWidgets((values) => ({
          ...values,
          [event.widgetKey]: stripAnsi(event.widgetLines?.join('\n') || ''),
        }))
    }
    if (initial.state.isCompacting) setActivity(tracker.current.handle({ type: 'compaction_start' }))
    initial.ui?.forEach(ui)
    let contextTimer: ReturnType<typeof setTimeout> | undefined
    let todoTimer: ReturnType<typeof setTimeout> | undefined
    let todoBusy = false,
      todoDirty = false
    const refreshTodo = () => {
      todoDirty = true
      if (todoTimer || todoBusy || !visibleRef.current) return
      todoTimer = setTimeout(async () => {
        todoTimer = undefined
        if (!alive.current || !visibleRef.current) return
        todoDirty = false
        todoBusy = true
        const sequence = ++todoSequence.current
        try {
          const data = await command('get_entries')
          if (alive.current && sequence === todoSequence.current)
            setSession((old) => ({ ...old, todo: projectTodos(old.commands, data) }))
        } catch {
          /* native settlement/snapshot retries */
        } finally {
          todoBusy = false
          if (todoDirty && alive.current) refreshTodo()
        }
      }, 250)
    }
    refreshVisibleTodo.current = () => {
      if (sessionRef.current.todo?.availability !== 'disabled') refreshTodo()
    }
    const batch = new EventBatch(
      (event) => {
        if (event.type === 'message_start' || event.type === 'message_end')
          latestMessage.current = event.message
        if (
          event.type.startsWith('message_') ||
          ['agent_start', 'agent_settled', 'desktop_error', 'compaction_start', 'compaction_end'].includes(
            event.type,
          )
        )
          streamRevision.current++
        if (event.type === 'queue_update') setQueued({ steering: event.steering, followUp: event.followUp })
        if (event.type === 'tool_execution_end' && sessionRef.current.todo?.availability !== 'disabled') {
          refreshTodo()
        }
        setActivity(tracker.current.view())
        if (event.type === 'message_end' && visibleRef.current && !contextTimer)
          contextTimer = setTimeout(() => {
            contextTimer = undefined
            if (alive.current) void refreshContext().catch(() => {})
          }, 200)
        if (event.type.startsWith('message_'))
          setSession((old) => ({ ...old, messages: applyMessageEvent(old.messages, event) }))
        if (event.type === 'agent_start' || event.type === 'compaction_start') setBusy(true)
        if (event.type === 'agent_settled') {
          setBusy(false)
          void sync().catch(showError)
        }
        if (event.type === 'compaction_end') {
          // Automatic compaction can resume an existing run; native state decides idle.
          void sync().catch(showError)
          if (event.errorMessage) showError(event.errorMessage)
        }
        if (event.type === 'desktop_diagnostic')
          addNotice(stripAnsi(event.message || ''), 'warning', 'native-diagnostic')
        if (event.type === 'auto_retry_start') setNotice(`Pi is retrying: ${event.errorMessage}`)
        if (event.type === 'auto_retry_end') {
          setNotice('')
          if (event.finalError) showError(event.finalError)
        }
        if (event.type === 'desktop_error' || event.type === 'extension_error') {
          showError(event.message || event.error)
          if (event.type === 'desktop_error') {
            setBusy(false)
            setDialogs([])
          }
        }
        if (event.type === 'extension_ui_request') ui(event)
      },
      () => visibleRef.current,
    )
    const off = window.desktop.onEvent((event) => {
      if (event.desktopSession !== handle) return
      if (event.type === 'desktop_subagents_status') {
        subagentRevision.current++
        setSubagents(event.status)
        return
      }
      if (event.type === 'desktop_error') {
        subagentRevision.current++
        setSubagents(old => old ? { ...old, error: 'Pi process disconnected' } : undefined)
      }
      if (['agent_start', 'agent_settled', 'desktop_error', 'compaction_start', 'compaction_end'].includes(event.type)) runRevision.current++
      // Observe clocks at arrival; only presentation is coalesced.
      tracker.current.handle(event, false)
      batch.push(event)
    })
    return () => {
      alive.current = false
      batch.dispose()
      refreshVisibleTodo.current = () => {}
      clearTimeout(contextTimer)
      clearTimeout(todoTimer)
      off()
    }
  }, [handle])
  useEffect(() => {
    if (visible) refreshVisibleTodo.current()
  }, [visible])
  useEffect(() => {
    if (visible) {
      document.title = extensionTitle
      void refreshContext().catch(() => {})
    }
  }, [visible, extensionTitle])
  useEffect(() => {
    attention(handle, dialogs.length)
    return () => attention(handle, 0)
  }, [handle, dialogs.length, attention])
  // Expiry is session-scoped even while the view is hidden.
  useEffect(() => {
    const timed = dialogs.filter((d) => typeof d.timeout === 'number')
    if (!timed.length) return
    const timer = setTimeout(
      () => {
        const expired = timed.filter((d) => d.desktopExpiresAt <= Date.now())
        uiRevision.current++
        for (const d of expired) answered.current.add(d.id)
        setDialogs((queue) => queue.filter((d) => !expired.some((e) => e.id === d.id)))
        for (const d of expired)
          void window.desktop
            .respond({ type: 'extension_ui_response', desktopSession: handle, id: d.id, cancelled: true })
            .catch(() => {})
      },
      Math.max(0, Math.min(...timed.map((d) => d.desktopExpiresAt)) - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [dialogs, handle])
  const stop = async () => {
    if (stopping.current) return
    stopping.current = true
    dispatchRevision.current++
    setSending(true)
    try {
      await command('clear_queue')
      await command('abort')
      await sync()
    } catch (e) {
      showError(e)
    } finally {
      stopping.current = false
      setSending(submitting.current)
    }
  }
  const run = async (type: string, args?: Record<string, unknown>) => {
    setError('')
    const transition = type === 'fork' || type === 'clone'
    if (transition) setLoading(true)
    try {
      const data = await command(type, args)
      if (transition) setActivity(tracker.current.reset())
      await sync()
      return data
    } catch (e) {
      showError(e)
      if (type === 'compact' || (type === 'prompt' && /^\/compact(?:\s|$)/.test(String(args?.message || ''))))
        await sync().catch(() => setBusy(false))
    } finally {
      if (transition) setLoading(false)
    }
  }
  const showBranches = async () => {
    try {
      setBranches((await command('get_fork_messages')).messages)
    } catch (e) {
      showError(e)
    }
  }
  const showTree = async () => {
    try {
      setTree((await command('get_tree')).tree)
    } catch (e) {
      showError(e)
    }
  }
  const refreshCommands = async () => {
    const { commands } = await command('get_commands')
    if (alive.current) setSession((old) => ({ ...old, commands }))
    return commands
  }
  useEffect(() => {
    if (!action || action.handle !== handle) return
    if (action.name === 'rename') setRename(session.state.sessionName || '')
    if (action.name === 'fork') void showBranches()
    if (action.name === 'clone') void run('clone')
    if (action.name === 'tree') void showTree()
    if (action.name === 'compact') void compact()
    if (action.name === 'terminal')
      setNotice(
        `Open in terminal after closing this session: pi --session ${JSON.stringify(session.state.sessionFile)}`,
      )
  }, [action?.sequence])
  const compact = async () => {
    if (busy || submitting.current || stopping.current) return
    submitting.current = true
    setLoading(true)
    try {
      const native = await refreshCommands()
      setLoading(false)
      runRevision.current++
      setBusy(true)
      if (
        native.some((c: { name: string; source: string }) => c.name === 'compact' && c.source === 'extension')
      )
        await run('prompt', { message: '/compact' })
      else await run('compact')
    } catch (e) {
      showError(e)
    } finally {
      submitting.current = false
      setLoading(false)
    }
  }
  const recall = async () => {
    if (submitting.current || stopping.current) return
    submitting.current = true
    setSending(true)
    try {
      const removed = await command('clear_queue')
      const text = [...(removed.steering || []), ...(removed.followUp || [])].join('\n\n')
      if (text) setDraft((old) => [old, text].filter(Boolean).join('\n\n'))
      setNotice(
        text
          ? 'Pending text recalled into the composer. Already delivered messages cannot be recalled. Attachment files are kept; reattach images to resend them as image content.'
          : 'No pending messages remain to recall.',
      )
    } catch (e) {
      showError(e)
    } finally {
      submitting.current = false
      setSending(false)
    }
  }
  const send = async (mode: 'steer' | 'followUp' = 'steer') => {
    if (submitting.current || stopping.current) return
    submitting.current = true
    setSending(true)
    try {
      await sendDraft(mode)
    } finally {
      submitting.current = false
      setSending(stopping.current)
    }
  }
  const sendDraft = async (mode: 'steer' | 'followUp') => {
    const revision = dispatchRevision.current
    const message = draft.trim()
    if ((!message && !attachments.length) || loading || attachmentOperation.current) return
    if (attachments.length && message.startsWith('/')) {
      showError('Send attachments with a message, not a slash command.')
      return
    }
    const payload = {
      message,
      ...(attachments.length ? { attachmentIds: attachments.map((a) => a.id) } : {}),
    }
    setError('')
    let native = session.commands
    if (message.startsWith('/')) {
      setLoading(true)
      try {
        native = await refreshCommands()
      } catch (e) {
        showError(e)
        return
      } finally {
        setLoading(false)
      }
      if (!alive.current || revision !== dispatchRevision.current) return
    }
    const route = routeCommand(message, native)
    if (route.kind === 'terminal') {
      setNotice(terminalCommands[route.name])
      return
    }
    if (route.kind === 'desktop') {
      if (busy) {
        setNotice('Wait for Pi to finish, or stop it before running this session operation.')
        return
      }
      if (route.name === 'new') {
        setDraft('')
        await navigate(session.workspace)
        return
      }
      if (route.name === 'name') {
        setDraft('')
        if (route.args) await run('set_session_name', { name: route.args })
        else setRename(session.state.sessionName || '')
        return
      }
      if (route.name === 'fork') {
        setDraft('')
        await showBranches()
        return
      }
      if (route.name === 'clone') {
        setDraft('')
        await run('clone')
        return
      }
      if (route.name === 'tree') {
        setDraft('')
        await showTree()
        return
      }
      if (route.name === 'compact') {
        setDraft('')
        runRevision.current++
        setBusy(true)
        await run('compact', { customInstructions: route.args })
        return
      }
      if (route.name === 'reload') {
        setLoading(true)
        setNotice('')
        try {
          const uiAtRequest = uiRevision.current
          syncSequence.current++
          const next = await window.desktop.reload(handle)
          setActivity(tracker.current.reset())
          setSession(next)
          if (uiAtRequest === uiRevision.current) restoreUI(next)
          changed(next)
          setDraft('')
          setNotice('Pi resources reloaded. Session history preserved.')
        } catch (e) {
          showError(e)
        } finally {
          setLoading(false)
        }
        return
      }
      try {
        if (route.name === 'copy') {
          const data = await command('get_last_assistant_text')
          if (data.text) await window.desktop.copyText(data.text)
          setNotice(data.text ? 'Response copied.' : 'No assistant response to copy.')
        }
        if (route.name === 'session') setNotice(JSON.stringify(await command('get_session_stats'), null, 2))
        if (route.name === 'export') {
          if (route.args && !route.args.endsWith('.html'))
            throw new Error('RPC export supports an optional .html output path only.')
          const data = await command('export_html', route.args ? { outputPath: route.args } : {})
          setNotice(`Exported to ${data.path}`)
        }
        if (route.name === 'resume') showSidebar?.()
        if (route.name === 'quit') window.close()
        setDraft('')
      } catch (e) {
        showError(e)
      }
      return
    }
    if (busy && !native.some((c) => c.name === route.name && c.source === 'extension')) {
      setDraft('')
      try {
        await command(mode === 'followUp' ? 'follow_up' : 'steer', payload)
        setAttachments([])
      } catch (e) {
        setDraft((old) => [message, old].filter(Boolean).join('\n\n'))
        showError(e)
      }
      return
    }
    streamRevision.current++
    runRevision.current++
    setBusy(true)
    setDraft('')
    if (!native.some((c) => c.name === route.name && c.source === 'extension'))
      setActivity(tracker.current.dispatch())
    try {
      const result = await command('prompt', payload)
      setAttachments([])
      if (result?.disposition === 'handled') {
        setActivity(tracker.current.handled())
        await sync()
      }
    } catch (e) {
      setBusy(false)
      setActivity(tracker.current.handle({ type: 'desktop_error' }))
      setDraft((old) => [message, old].filter(Boolean).join('\n\n'))
      showError(e)
    }
  }
  const answer = (id: string, fields: Record<string, unknown>) => {
    const request = dialogs.find((request) => request.id === id)
    if (!request || answered.current.has(id)) return
    uiRevision.current++
    answered.current.add(request.id)
    setDialogs((queue) => queue.filter((d) => d.id !== request.id))
    void window.desktop
      .respond({ type: 'extension_ui_response', desktopSession: handle, id: request.id, ...fields })
      .catch(showError)
  }
  useEffect(() => {
    if (!visible) return
    const key = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        document.querySelector(
          '[role="menu"], dialog[open], [aria-label="Preferences"][role="dialog"], [role="dialog"][aria-modal="true"]',
        )
      )
        return
      if (e.key === 'Escape' && busy && !dialogs.length && rename === undefined && !branches && !tree) {
        e.preventDefault()
        void stop()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
        e.preventDefault()
        if (dialogs.length) {
          if (reading) viewRoot.current?.querySelector<HTMLElement>('.conversation')?.focus({ preventScroll: true })
        } else composer.current?.focus()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [visible, busy, dialogs.length, reading, rename, branches, tree])
  useEffect(() => {
    if (!visible) return
    const modal = document.querySelector<HTMLElement>(`.session-view:not([hidden]) [role="dialog"]`)
    if (!modal || modal.classList.contains('review-sheet')) return
    const previous = document.activeElement as HTMLElement | null
    const focusable = () => [
      ...modal.querySelectorAll<HTMLElement>(
        'button:not(:disabled),input,textarea,select,a[href],[tabindex="0"]',
      ),
    ]
    ;(modal.querySelector<HTMLElement>('[data-dismiss-request]') || focusable()[0])?.focus()
    const trap = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setRename(undefined)
        setBranches(undefined)
        setTree(undefined)
      }
      if (e.key === 'Tab') {
        const items = focusable(),
          first = items[0],
          last = items.at(-1)
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }
    }
    modal.addEventListener('keydown', trap)
    return () => {
      modal.removeEventListener('keydown', trap)
      if (previous?.isConnected) previous.focus()
    }
  }, [visible, rename !== undefined, branches !== undefined, tree !== undefined, dialogs[0]?.id])
  const workspaceName =
    preferences.workspaces.find((w) => w.path === session.workspace)?.name || session.workspace
  const title =
    session.state.sessionName ||
    messageText(session.messages.find((m) => m.role === 'user') || { role: 'user' }).slice(0, 65) ||
    t('New conversation')
  return (
    <MarkdownOrigin.Provider value={markdownOrigin}><section ref={viewRoot} className="session-view" hidden={!visible} data-session-handle={handle}>
      <header className="topbar">
        <button
          className="icon-button"
          aria-label={t("Toggle sidebar")}
          title={t("Toggle sidebar")}
          onClick={toggleSidebar}
        >
          <PanelLeft size={18} />
        </button>
        <div className="breadcrumbs">
          <span>{workspaceName}</span>
          <ChevronRight size={12} />
          <strong title={title}>{title}</strong>
        </div>
        <div className="header-actions">
          <button
            className={`icon-button ${filesOpen ? 'active' : ''}`}
            aria-label={t("Toggle files")}
            title={filesOpen ? t('Close files') : t('Open files')}
            onClick={toggleFiles}
          >
            <FilesIcon size={17} />
          </button>
        </div>
      </header>
      <div className="chat-area">
        {loading ? (
          <div className="empty-state">
            <span className="pi-hero">π</span>
            <p>{t("Updating your conversation…")}</p>
          </div>
        ) : displayedMessages.length ? (
          <Conversation
            key={session.state.sessionFile}
            messages={displayedMessages}
            busy={busy}
            activity={activity}
            workspace={session.workspace}
            handle={session.handle}
            active={visible}
            modelProvider={session.state.model?.provider}
            onSubagentDraft={draftSubagentGuidance}
            requestNavigation={requestNavigation}
          />
        ) : (
          <div className="empty-state">
            <span className="pi-hero">π</span>
            <h1>{t("A little space to think.")}</h1>
            <p>{t("Explore an idea, work through a problem, or build something.")}</p>
            {activity.compaction ? (
              <CompactionNotice value={activity.compaction} modelProvider={session.state.model?.provider} />
            ) : (
              busy && <p role="status">{t("Pi is working…")}</p>
            )}
          </div>
        )}
        <footer className="composer-dock">
          {reading && (
            <section className="permission-pending" aria-label={t("Pending permission")}>
              <span className="permission-pending-icon">
                <MessageCircleMore size={18} />
              </span>
              <div>
                <strong>{t("Response still pending")}</strong>
                <span title={`${workspaceName} / ${title}`}>
                  {workspaceName} / {title}{t("· Nothing submitted")}</span>
              </div>
              <button type="button" className="primary" onClick={() => setReading(false)}>{t("Return to review")}</button>
            </section>
          )}
          <div className="composer-content" hidden={reading}>
            {!!(queued.steering.length + queued.followUp.length) && (
              <div className="pending-messages" aria-label={t("Pending messages")}>
                <header>
                  <span>{t("Waiting to send")}</span>
                  <button disabled={sending} onClick={() => void recall()}>{t("Recall all")}</button>
                </header>
                {(['steering', 'followUp'] as const).map((kind) =>
                  queued[kind].map((text, index) => (
                    <div key={`${kind}-${index}`}>
                      <small>{kind === 'steering' ? t('Steer') : t('Follow-up')}</small>
                      <span>{text || t('Image attachment')}</span>
                    </div>
                  )),
                )}
              </div>
            )}
            <SubagentFocusCard status={subagents} active={visible} requestForAgent={agent => requestForAgent(displayedMessages, agent)}
              onRequest={requestId => setRequestNavigation(old => ({ requestId, sequence: (old?.sequence ?? 0) + 1 }))} />
            <Composer
              usage={usage}
              session={session}
              draft={draft}
              setDraft={setDraft}
              inputRef={composer}
              commands={commandCatalog(session.commands)}
              refreshCommands={() => {
                void refreshCommands().catch(showError)
              }}
              busy={busy}
              loading={loading || attaching || navigationPending}
              sending={sending}
              attachments={attachments}
              attach={attach}
              removeAttachment={removeAttachment}
              enterToSend={preferences.enterToSend}
              widgets={subagents?.availability === 'available'
                ? Object.fromEntries(Object.entries(widgets).filter(([key]) => !['subagent-async', 'subagent-fleet-status'].includes(key)))
                : widgets}
              statuses={
                usage?.windows.length && supportsCodexFeatures(session.state.model)
                  ? Object.fromEntries(Object.entries(statuses).filter(([key]) => key !== 'usage'))
                  : statuses
              }
              send={send}
              stop={stop}
              run={run}
            />

          </div>
        </footer>
      </div>
      {visible && rename !== undefined && (
        <div className="modal-shade">
          <form
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("Rename session")}
            onSubmit={(e) => {
              e.preventDefault()
              void run('set_session_name', { name: rename })
              setRename(undefined)
            }}
          >
            <h2>{t("Rename conversation")}</h2>
            <input
              autoFocus
              aria-label={t("Session name")}
              maxLength={200}
              required
              value={rename}
              onChange={(e) => setRename(e.target.value)}
            />
            <div className="dialog-actions">
              <button type="button" onClick={() => setRename(undefined)}>{t("Cancel")}</button>
              <button className="primary">{t("Save")}</button>
            </div>
          </form>
        </div>
      )}
      {visible && (branches || tree) && (
        <div className="modal-shade">
          <div
            className="dialog branch-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={branches ? t('Branch conversation') : t('Session tree')}
          >
            <div className="panel-heading">
              <h2>{branches ? t('Branch from a message') : t('Native session tree')}</h2>
              <button
                className="icon-button"
                aria-label={t("Close branches")}
                onClick={() => {
                  setBranches(undefined)
                  setTree(undefined)
                }}
              >
                <X size={18} />
              </button>
            </div>
            <p className="muted">
              {branches
                ? t('Creates a native Pi branch. Your existing history remains intact.')
                : t('Read-only tree. RPC supports forking user messages, but not arbitrary in-file tree navigation. Use terminal /tree for that.')}
            </p>
            {branches?.map((branch) => {
              const branchText = splitAttachmentBlock(branch.text)?.text ?? branch.text
              return (
                <button
                  className="branch-item"
                  key={branch.entryId}
                  onClick={async () => {
                    setBranches(undefined)
                    const result = await run('fork', { entryId: branch.entryId })
                    if (result?.text)
                      setDraft(splitAttachmentBlock(result.text)?.text ?? result.text)
                  }}
                >
                  {(branchText || 'Attachment').slice(0, 240)}
                </button>
              )
            })}
            {branches?.length === 0 && <p>{t("No user messages available to branch from.")}</p>}
            {tree && <Tree nodes={tree} />}
          </div>
        </div>
      )}
      {dialogs[0] && (
        <ExtensionDialog
          key={dialogs[0].id}
          request={dialogs[0]}
          context={`${workspaceName} / ${title}`}
          workspace={workspaceName}
          sessionTitle={title}
          active={visible}
          reading={reading}
          onReadingChange={setReading}
          answer={(fields) => answer(dialogs[0].id, fields)}
        />
      )}
    </section></MarkdownOrigin.Provider>
  )
}
function Tree({ nodes }: { nodes: any[] }) {
  return (
    <ul className="session-tree">
      {nodes.map((node) => (
        <li key={node.entry.id}>
          <span>
            {node.entry.message
              ? `${node.entry.message.role}: ${visibleMessageText(node.entry.message).slice(0, 100)}`
              : node.entry.type}
          </span>
          {node.children?.length > 0 && <Tree nodes={node.children} />}
        </li>
      ))}
    </ul>
  )
}
