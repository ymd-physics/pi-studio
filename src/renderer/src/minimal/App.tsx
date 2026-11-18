import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Plus,
  FolderPlus,
  PanelLeft,
  Info,
  ChevronRight,
  X,
  Settings2,
  Circle,
  LoaderCircle,
  MessageCircleMore,
  Pencil,
  GitFork,
  Copy,
  ListTree,
  Minimize2,
  Terminal,
  Trash2,
  Power,
} from 'lucide-react'
import type {
  DesktopAPI,
  Preferences,
  RunningSession,
  SessionInfo,
  Snapshot,
  Workspace,
} from '../../../../packages/shared/desktop'
import { version as appVersion } from '../../../../package.json'
import { SessionView, type SessionAction } from './SessionView'
import { TerminalView } from './TerminalView'
import { TerminalNameDialog } from './TerminalNameDialog'
import type { TerminalInfo } from '../../../../packages/shared/terminal'
import { Files } from './Files'
import { PreferencesPanel } from './PreferencesPanel'
import { WorkspaceInfo } from './WorkspaceInfo'
import { ResizeEdge, usePanelWidths } from './ResizeEdge'
import type { CodexUsageSnapshot } from '../../../../packages/shared/codex-usage'

declare global {
  interface Window {
    desktop: DesktopAPI
  }
}
type Context = { workspace: string; item: SessionInfo; x: number; y: number }
function menuNavigation(event: React.KeyboardEvent<HTMLDivElement>) {
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next].focus()
}
export function App() {
  const [preferences, setPreferences] = useState<Preferences>()
  const [runtime, setRuntime] = useState('Connecting to your Pi installation…')
  const [sessions, setSessions] = useState<Record<string, SessionInfo[]>>({})
  const [views, setViews] = useState<Record<string, Snapshot>>({})
  const [terminalSessions, setTerminalSessions] = useState<TerminalInfo[]>([])
  const [selected, setSelected] = useState<string>()
  const [running, setRunning] = useState<RunningSession[]>([])
  const [usage, setUsage] = useState<CodexUsageSnapshot>()
  const [waiting, setWaiting] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const [openingKind, setOpeningKind] = useState<'conversation' | 'terminal'>('conversation')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [sessionNotice, setSessionNotice] = useState<{
    handle: string
    id: number
    text: string
    level: 'error' | 'info'
  }>()
  const [sidebar, setSidebar] = useState(true)
  const [dropWorkspace, setDropWorkspace] = useState<string>()
  const [fileRevision, setFileRevision] = useState(0)
  const [files, setFiles] = useState(false)
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('pi-collapsed-workspaces') || '[]')
      return Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string') : []
    } catch {
      return []
    }
  })
  const toggleWorkspace = (path: string) =>
    setCollapsed((old) => {
      const next = old.includes(path) ? old.filter((p) => p !== path) : [...old, path]
      localStorage.setItem('pi-collapsed-workspaces', JSON.stringify(next))
      return next
    })
  const [dirty, setDirty] = useState(false)
  const [settings, setSettings] = useState(false)
  const [workspaceInfo, setWorkspaceInfo] = useState<Workspace>()
  const loadGlobalPlugins = useCallback(() => window.desktop.plugins(), [])
  const loadWorkspacePlugins = useCallback(() => window.desktop.plugins(workspaceInfo!.path), [workspaceInfo?.path])
  const [context, setContext] = useState<Context>()
  const [action, setAction] = useState<SessionAction>()
  const [creationMenu, setCreationMenu] = useState<{ workspace: string; x: number; y: number }>()
  const [terminalContext, setTerminalContext] = useState<{ id: string; x: number; y: number }>()
  const [terminalRename, setTerminalRename] = useState<TerminalInfo>()
  const [terminalAction, setTerminalAction] = useState<{ id: string; name: 'clear'; sequence: number }>()
  const menuFocus = useRef<HTMLElement | null>(null)
  const terminalRevision = useRef(0)
  const preferenceRevision = useRef(0)
  const prefs = useRef(preferences)
  prefs.current = preferences
  const navigating = useRef(false)
  const revision = useRef(0)
  const session = selected ? views[selected] : undefined
  const selectedTerminal = terminalSessions.find((terminal) => selected === `terminal:${terminal.id}`)
  const workspaceForNew =
    selectedTerminal?.workspace || session?.workspace ||
    preferences?.workspaces.find((w) => w.path === preferences.activeWorkspace)?.path ||
    preferences?.workspaces[0]?.path
  const widths = usePanelWidths(sidebar, files)
  useEffect(() => {
    if (!selected || !session || (!error && !notice)) return
    setSessionNotice({
      handle: selected,
      id: Date.now(),
      text: [error, notice].filter(Boolean).join('\n'),
      level: error ? 'error' : 'info',
    })
    setError('')
    setNotice('')
  }, [selected, !!session, error, notice])
  const showError = useCallback(
    (e: unknown) =>
      setError(String(e).replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, '')),
    [],
  )
  const refreshSessions = useCallback(async () => {
    const id = ++revision.current
    const lists = await Promise.all(
      (prefs.current?.workspaces || []).map(
        async (w) => [w.path, await window.desktop.sessions(w.path)] as const,
      ),
    )
    if (id === revision.current) setSessions(Object.fromEntries(lists))
  }, [])
  const refreshTerminals = useCallback(async () => {
    const id = ++terminalRevision.current
    const next = await window.desktop.terminals()
    if (id === terminalRevision.current) setTerminalSessions(next)
  }, [])
  useEffect(() => {
    if (selected?.startsWith('terminal:') && !selectedTerminal) setSelected(undefined)
  }, [selected, selectedTerminal])
  const changed = useCallback(
    (snapshot: Snapshot) => {
      setViews((old) => (old[snapshot.handle] ? { ...old, [snapshot.handle]: snapshot } : old))
      void refreshSessions().catch(showError)
    },
    [refreshSessions, showError],
  )
  const attention = useCallback(
    (handle: string, value: number) =>
      setWaiting((old) => (old[handle] === value ? old : { ...old, [handle]: value })),
    [],
  )
  const navigate = useCallback(
    async (workspace: string, path?: string): Promise<Snapshot | undefined> => {
      if (navigating.current) return
      if (dirty && !window.confirm('Discard unsaved file changes?')) return
      navigating.current = true
      setOpeningKind('conversation')
      setLoading(true)
      setError('')
      setContext(undefined)
      setCreationMenu(undefined)
      setTerminalContext(undefined)
      try {
        const next = await window.desktop.open(workspace, path)
        setViews((old) => ({ ...old, [next.handle]: old[next.handle] || next }))
        setSelected(next.handle)
        setFiles(false)
        setDirty(false)
        setRunning(await window.desktop.runningSessions())
        await refreshSessions()
        return next
      } catch (e) {
        showError(e)
      } finally {
        navigating.current = false
        setLoading(false)
      }
    },
    [dirty, refreshSessions, showError],
  )
  const newConversation = useCallback(() => {
    if (!workspaceForNew || loading) return
    void navigate(workspaceForNew)
  }, [workspaceForNew, loading, navigate])
  const selectTerminal = (terminal: TerminalInfo) => {
    if (navigating.current || (dirty && !window.confirm('Discard unsaved file changes?'))) return
    setSelected(`terminal:${terminal.id}`)
    setFiles(false)
    setDirty(false)
    setContext(undefined)
    setCreationMenu(undefined)
    setTerminalContext(undefined)
  }
  const createTerminal = async (workspace: string) => {
    if (navigating.current || (dirty && !window.confirm('Discard unsaved file changes?'))) return
    navigating.current = true
    setOpeningKind('terminal')
    setLoading(true)
    setError('')
    setCreationMenu(undefined)
    try {
      const terminal = await window.desktop.createTerminal(workspace)
      await refreshTerminals()
      setSelected(`terminal:${terminal.id}`)
      setFiles(false)
      setDirty(false)
    } catch (error) { showError(error) }
    finally { navigating.current = false; setLoading(false) }
  }
  const closeTerminal = async (id: string) => {
    setTerminalContext(undefined)
    try { if (await window.desktop.closeTerminal(id)) await refreshTerminals() }
    catch (error) { showError(error) }
  }
  useEffect(() => {
    let alive = true
    const off = window.desktop.onEvent((event) => {
      if (event.type === 'desktop_codex_usage') setUsage(event.usage)
      if (event.type === 'desktop_terminal_sessions') {
        terminalRevision.current++
        setTerminalSessions(event.terminals)
      }
      if (event.type === 'desktop_terminal_error') setError(event.message || 'The terminal could not continue safely')
      if (event.type === 'desktop_terminal_closed') void window.desktop.closeTerminal(event.id).catch(showError)
      if (event.type === 'desktop_sessions_changed') {
        setRunning(event.sessions)
        const handles = new Set(event.sessions.map((s: RunningSession) => s.handle))
        setViews((old) => Object.fromEntries(Object.entries(old).filter(([handle]) => handles.has(handle))))
        void refreshSessions().catch(showError)
      }
    })
    void window.desktop
      .boot()
      .then(async (data) => {
        if (!alive) return
        setPreferences(data.preferences)
        prefs.current = data.preferences
        setRuntime(data.runtime)
        setUsage(await window.desktop.codexUsage())
        setRunning(await window.desktop.runningSessions())
        await refreshSessions()
        await refreshTerminals()
        if (data.preferences.activeWorkspace)
          await navigate(data.preferences.activeWorkspace, data.preferences.activeSession)
      })
      .catch(showError)
    return () => {
      alive = false
      off()
    }
  }, [])
  useEffect(() => {
    const refresh = () => {
      if (prefs.current) void refreshSessions().catch(showError)
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refreshSessions, showError])
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () =>
      document.documentElement.classList.toggle(
        'dark',
        preferences?.theme === 'dark' || (preferences?.theme === 'system' && media.matches),
      )
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [preferences?.theme])
  useEffect(() => {
    document.documentElement.dataset.font = preferences?.font === 'serif' ? 'serif' : 'default'
  }, [preferences?.font])
  useEffect(() => {
    void window.desktop.documentDirty(dirty).catch(showError)
  }, [dirty, showError])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return
      // Ctrl belongs to the shell/editor while focused inside a terminal. macOS
      // Cmd application shortcuts and native Cmd +/-/0 zoom remain unchanged.
      if (e.ctrlKey && !e.metaKey && e.target instanceof Element && e.target.closest('.terminal-view')) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        setSidebar((v) => !v)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n' && workspaceForNew && !loading) {
        e.preventDefault()
        newConversation()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [newConversation, loading, workspaceForNew])
  useEffect(() => {
    if (!context && !creationMenu && !terminalContext) return
    const dismiss = () => { setContext(undefined); setCreationMenu(undefined); setTerminalContext(undefined) }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        dismiss()
        if (menuFocus.current?.isConnected) menuFocus.current.focus()
      }
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('blur', dismiss)
    window.addEventListener('keydown', key)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('keydown', key)
      window.removeEventListener('resize', dismiss)
    }
  }, [context, creationMenu, terminalContext])
  useEffect(() => {
    const id = creationMenu ? 'workspace-creation-menu' : terminalContext ? 'terminal-actions-menu' : undefined
    if (id) document.getElementById(id)?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [creationMenu, terminalContext])
  const addWorkspace = async () => {
    try {
      const next = await window.desktop.addWorkspace()
      setPreferences(next)
      prefs.current = next
      await refreshSessions()
    } catch (e) {
      showError(e)
    }
  }
  const updatePreferences = async (patch: Parameters<DesktopAPI['preferences']>[0]) => {
    const before = prefs.current
    if (!before) return
    const id = ++preferenceRevision.current
    const optimistic = { ...before, ...patch }
    setPreferences(optimistic)
    prefs.current = optimistic
    try {
      const next = await window.desktop.preferences(patch)
      if (id === preferenceRevision.current) { setPreferences(next); prefs.current = next }
    } catch (e) {
      if (id === preferenceRevision.current) { setPreferences(before); prefs.current = before; showError(e) }
    }
  }
  const discardView = (handle?: string) => {
    if (!handle) return
    setViews((old) => {
      const next = { ...old }
      delete next[handle]
      return next
    })
    if (selected === handle) {
      setSelected(undefined)
      setFiles(false)
      setDirty(false)
    }
  }
  const contextAction = async (name: string) => {
    if (!context) return
    const { item, workspace } = context
    setContext(undefined)
    setError('')
    const live = running.find((r) => r.path === item.path && r.workspace === workspace)
    if (['close', 'delete'].includes(name)) {
      if (name === 'close' && live?.status === 'working') return
      if (live?.handle === selected && dirty && !window.confirm('Discard unsaved file changes?')) return
      try {
        if (name === 'close') {
          if (!live) return
          await window.desktop.closeSession(live.handle)
        } else if (!(await window.desktop.deleteSession(workspace, item.path))) return
        discardView(live?.handle)
        setRunning(await window.desktop.runningSessions())
        await refreshSessions()
        if (name === 'delete') setNotice('Session moved to Trash. Separate forks and clones were kept.')
      } catch (e) {
        showError(e)
      }
      return
    }
    const next = await navigate(workspace, item.path)
    if (next) setAction({ handle: next.handle, name, sequence: Date.now() })
  }
  const toggleFiles = () => {
    if (!files || !dirty || window.confirm('Discard unsaved file changes?')) {
      setFiles(!files)
      setDirty(false)
    }
  }
  const currentLive =
    context && running.find((r) => r.workspace === context.workspace && r.path === context.item.path)
  const contextBusy = currentLive?.status === 'working'
  return (
    <div
      className={`app ${sidebar ? '' : 'sidebar-hidden'}`}
      style={{ gridTemplateColumns: sidebar ? `${widths.left}px minmax(0, 1fr)` : 'minmax(0, 1fr)' }}
      onClick={(e) => {
        const anchor = (e.target as HTMLElement).closest('a')
        if (anchor?.href) {
          e.preventDefault()
          void window.desktop.openExternal(anchor.href).catch(showError)
        }
      }}
    >
      {sidebar && (
        <aside className="sidebar">
          <div className="brand">
            <span className="pi-mark">π</span>
            <div className="brand-identity">
              <div className="brand-name">Pi Studio</div>
              <span className="brand-version" aria-label="Pi Studio version">
                v{appVersion}
              </span>
            </div>
          </div>
          <div className="sidebar-label">
            <h2>Workspaces</h2>
            <button
              className="icon-button"
              aria-label="Add workspace"
              title="Add workspace"
              disabled={!preferences || loading}
              onClick={() => void addWorkspace()}
            >
              <FolderPlus size={16} />
            </button>
          </div>
          <nav aria-label="Workspaces and sessions" className="workspace-list">
            {preferences?.workspaces.map((workspace) => {
              const waitingSessions = running.filter(
                (live) => live.workspace === workspace.path && (waiting[live.handle] || 0) > 0,
              ).length
              return (
                <section key={workspace.path} className="workspace">
                  <div
                    className={`workspace-heading ${dropWorkspace === workspace.path ? 'drag-over' : ''}`}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes('Files')) {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'copy'
                        setDropWorkspace(workspace.path)
                      }
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropWorkspace(undefined)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      setDropWorkspace(undefined)
                      const paths = Array.from(e.dataTransfer.files)
                        .map((f) => window.desktop.pathForFile(f))
                        .filter(Boolean)
                      if (!paths.length) return
                      void window.desktop
                        .copyIntoWorkspace(workspace.path, '', paths)
                        .then(() => {
                          setNotice(`Copied ${paths.length} item(s) into ${workspace.name}. Originals kept.`)
                          setFileRevision((value) => value + 1)
                        })
                        .catch(showError)
                    }}
                  >
                    <button
                      disabled={loading}
                      title={workspace.path}
                      aria-expanded={!collapsed.includes(workspace.path)}
                      onClick={() => toggleWorkspace(workspace.path)}
                    >
                      <ChevronRight size={13} />
                      <span>{workspace.name}</span>
                    </button>
                    {waitingSessions > 0 && collapsed.includes(workspace.path) && (
                      <span
                        className="workspace-attention"
                        role="status"
                        aria-label={`${waitingSessions} session${waitingSessions === 1 ? '' : 's'} waiting for your response`}
                        title={`${waitingSessions} session${waitingSessions === 1 ? '' : 's'} waiting for your response`}
                      >
                        <MessageCircleMore size={13} aria-hidden="true" />
                        {waitingSessions}
                      </span>
                    )}
                    <button
                      className="icon-button"
                      aria-label={`Workspace information for ${workspace.name}`}
                      title="Workspace information"
                      onClick={() => setWorkspaceInfo(workspace)}
                    >
                      <Info size={14} />
                    </button>
                    <button
                      className="icon-button"
                      disabled={loading}
                      title="New conversation or terminal"
                      aria-label={`New session in ${workspace.name}`}
                      aria-haspopup="menu"
                      aria-expanded={creationMenu?.workspace === workspace.path}
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect()
                        menuFocus.current = event.currentTarget
                        setContext(undefined)
                        setTerminalContext(undefined)
                        setCreationMenu((old) => old?.workspace === workspace.path ? undefined : {
                          workspace: workspace.path, x: Math.max(8, Math.min(rect.right - 230, window.innerWidth - 238)),
                          y: Math.min(rect.bottom + 5, window.innerHeight - 145),
                        })
                      }}
                    >
                      <Plus size={14} />
                    </button>
                    <button
                      className="icon-button remove-workspace"
                      disabled={loading}
                      aria-label={`Remove ${workspace.name}`}
                      title={`Remove ${workspace.name}`}
                      onClick={async () => {
                        if (
                          dirty &&
                          session?.workspace === workspace.path &&
                          !window.confirm('Discard unsaved file changes?')
                        )
                          return
                        try {
                          const next = await window.desktop.removeWorkspace(workspace.path)
                          setPreferences(next)
                          prefs.current = next
                          if (next.workspaces.some((w) => w.path === workspace.path)) return // native confirmation cancelled
                          for (const live of running.filter((r) => r.workspace === workspace.path))
                            discardView(live.handle)
                          setRunning(await window.desktop.runningSessions())
                          await refreshSessions()
                        } catch (e) {
                          showError(e)
                        }
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                  {!collapsed.includes(workspace.path) &&
                    (sessions[workspace.path] || []).map((item) => {
                      const live = running.find((r) => r.path === item.path && r.workspace === workspace.path)
                      const pendingRequests = live ? waiting[live.handle] || 0 : 0
                      const status = pendingRequests > 0 ? 'waiting' : live?.status || 'inactive'
                      const name = item.name || item.firstMessage || 'Untitled conversation'
                      return (
                        <button
                          className={`session-link ${session?.state.sessionFile === item.path ? 'selected' : ''}`}
                          key={item.path}
                          disabled={loading}
                          aria-current={session?.state.sessionFile === item.path ? 'page' : undefined}
                          data-status={status}
                          title={`${name} · ${pendingRequests ? `Waiting for your response · ${pendingRequests} pending request${pendingRequests === 1 ? '' : 's'}` : status}`}
                          onClick={() => void navigate(workspace.path, item.path)}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            setContext({
                              workspace: workspace.path,
                              item,
                              x: Math.min(e.clientX, window.innerWidth - 238),
                              y: Math.min(e.clientY, window.innerHeight - 340),
                            })
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                              e.preventDefault()
                              const r = e.currentTarget.getBoundingClientRect()
                              setContext({
                                workspace: workspace.path,
                                item,
                                x: Math.min(r.right, window.innerWidth - 238),
                                y: Math.min(r.top, window.innerHeight - 340),
                              })
                            }
                          }}
                        >
                          <span
                            className={`session-status is-${status}`}
                            aria-label={pendingRequests ? 'Waiting for your response' : status}
                          >
                            {pendingRequests ? (
                              <MessageCircleMore size={14} aria-hidden="true" />
                            ) : status === 'working' ? (
                              <LoaderCircle size={12} className="spin" />
                            ) : (
                              <Circle size={9} fill="currentColor" strokeWidth={0} />
                            )}
                          </span>
                          <span className="session-label">{name}</span>
                        </button>
                      )
                    })}
                  {!collapsed.includes(workspace.path) && terminalSessions.filter((terminal) => terminal.workspace === workspace.path).map((terminal) => (
                    <button key={`terminal:${terminal.id}`} className={`session-link terminal-link ${selectedTerminal?.id === terminal.id ? 'selected' : ''}`}
                      data-terminal-id={terminal.id} aria-current={selectedTerminal?.id === terminal.id ? 'page' : undefined}
                      aria-haspopup="menu" title={`${terminal.name} · ${terminal.state}`} disabled={loading}
                      onClick={() => selectTerminal(terminal)} onContextMenu={(event) => {
                        event.preventDefault(); menuFocus.current = event.currentTarget; setContext(undefined); setCreationMenu(undefined)
                        setTerminalContext({ id: terminal.id, x: Math.min(event.clientX, window.innerWidth - 238), y: Math.min(event.clientY, window.innerHeight - 155) })
                      }} onKeyDown={(event) => {
                        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                        event.preventDefault(); menuFocus.current = event.currentTarget
                        const rect = event.currentTarget.getBoundingClientRect()
                        setContext(undefined); setCreationMenu(undefined)
                        setTerminalContext({ id: terminal.id, x: Math.min(rect.right, window.innerWidth - 238), y: Math.min(rect.top, window.innerHeight - 155) })
                      }}>
                      <Terminal size={13} aria-hidden="true" /><span className="session-label">{terminal.name}</span>
                      <span className="terminal-live-dot" aria-label={`Terminal ${terminal.state}`} />
                    </button>
                  ))}
                  {!collapsed.includes(workspace.path) && !sessions[workspace.path]?.length && !terminalSessions.some((terminal) => terminal.workspace === workspace.path) && (
                    <span className="no-sessions">No sessions yet</span>
                  )}
                </section>
              )
            })}
          </nav>
          <div className="sidebar-bottom">
            <button onClick={() => setSettings(true)}>
              <Settings2 size={16} /> Preferences
            </button>
            <span title={runtime}>
              <span className="connection-dot" /> Your local Pi
            </span>
          </div>
          <ResizeEdge
            side="left"
            value={widths.left}
            min={widths.leftMin}
            max={widths.leftMax}
            change={widths.setLeft}
          />
        </aside>
      )}
      <main className="main">
        {error && !session && (
          <div role="alert" className="banner error">
            <span>{error}</span>
            <button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={15} />
            </button>
          </div>
        )}
        {notice && !session && (
          <div role="status" className="banner">
            <span>{notice}</span>
            <button className="icon-button" aria-label="Dismiss notice" onClick={() => setNotice('')}>
              <X size={15} />
            </button>
          </div>
        )}
        {loading && (
          <div className="opening-indicator" role="status">
            <LoaderCircle size={13} className="spin" /> Opening {openingKind}…
          </div>
        )}
        <div className="main-body">
          <div className="session-stack">
            {preferences &&
              Object.values(views).map((view) => (
                <SessionView
                  key={view.handle}
                  initial={view}
                  visible={view.handle === selected}
                  navigationPending={loading}
                  externalNotice={sessionNotice?.handle === view.handle ? sessionNotice : undefined}
                  preferences={preferences}
                  usage={usage}
                  action={action}
                  toggleSidebar={() => setSidebar((v) => !v)}
                  showSidebar={() => setSidebar(true)}
                  toggleFiles={toggleFiles}
                  filesOpen={files}
                  navigate={async (workspace, path) => {
                    await navigate(workspace, path)
                  }}
                  changed={changed}
                  attention={attention}
                />
              ))}
            {preferences && terminalSessions.map((terminal) => <TerminalView key={`terminal:${terminal.id}`} info={terminal}
              visible={selectedTerminal?.id === terminal.id} transport={window.desktop.terminal}
              workspaceName={preferences.workspaces.find((workspace) => workspace.path === terminal.workspace)?.name}
              terminalFontSize={preferences.terminalFontSize ?? 'auto'} onFontSizeChange={(terminalFontSize) => void updatePreferences({ terminalFontSize })}
              toggleSidebar={() => setSidebar((value) => !value)} onClose={() => void closeTerminal(terminal.id)} action={terminalAction} />)}
            {!session && !selectedTerminal && (
              <>
                <header className="topbar">
                  <button
                    className="icon-button"
                    aria-label="Toggle sidebar"
                    title="Toggle sidebar"
                    onClick={() => setSidebar(!sidebar)}
                  >
                    <PanelLeft size={18} />
                  </button>
                  <span className="muted">Pi Studio</span>
                </header>
                <div className="empty-state">
                  <span className="pi-hero">π</span>
                  <h1>A little space to think.</h1>
                  <p>Your conversations, tools, and ideas. One quiet workspace.</p>
                  {preferences?.workspaces.length ? (
                    <button
                      className="subtle-button"
                      disabled={!workspaceForNew}
                      onClick={newConversation}
                    >
                      <Plus size={16} /> New conversation
                    </button>
                  ) : (
                    <button
                      className="subtle-button"
                      disabled={!preferences}
                      onClick={() => void addWorkspace()}
                    >
                      <FolderPlus size={16} /> Add a workspace
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          {files && session && (
            <div className="file-panel-container" style={{ width: widths.right }}>
              <ResizeEdge
                side="right"
                value={widths.right}
                min={widths.rightMin}
                max={widths.rightMax}
                change={widths.setRight}
              />
              <Files
                key={session.handle}
                handle={session.handle}
                refreshKey={fileRevision}
                close={toggleFiles}
                onDirty={setDirty}
              />
            </div>
          )}
        </div>
      </main>
      {context && (
        <div
          className="menu session-context-menu"
          role="menu"
          aria-label="Session actions"
          style={{ left: Math.max(4, context.x), top: Math.max(4, context.y) }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="context-menu-title">
            {context.item.name || context.item.firstMessage || 'Untitled conversation'}
          </div>
          {(
            [
              ['rename', 'Rename session', Pencil],
              ['fork', 'Fork from message…', GitFork],
              ['clone', 'Clone session', Copy],
              ['tree', 'Session tree', ListTree],
              ['compact', 'Compact context', Minimize2],
              ['terminal', 'Show terminal command', Terminal],
              ['close', 'Close session', Power],
              ['delete', 'Delete session…', Trash2],
            ] as const
          ).map(([name, label, Icon]) => (
            <button
              role="menuitem"
              key={name}
              className={name === 'delete' ? 'error-text' : ''}
              disabled={
                loading ||
                (contextBusy && !['tree', 'terminal', 'delete'].includes(name)) ||
                (name === 'close' && !currentLive)
              }
              onClick={() => void contextAction(name)}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
      )}
      {creationMenu && <div id="workspace-creation-menu" className="menu session-context-menu workspace-creation-menu" role="menu"
        aria-label="New workspace session" style={{ left: creationMenu.x, top: creationMenu.y }}
        onPointerDown={(event) => event.stopPropagation()} onKeyDown={menuNavigation}>
        <button role="menuitem" onClick={() => void navigate(creationMenu.workspace)}><MessageCircleMore size={14} />New conversation</button>
        <button role="menuitem" onClick={() => void createTerminal(creationMenu.workspace)}><Terminal size={14} />New terminal</button>
      </div>}
      {terminalContext && <div id="terminal-actions-menu" className="menu session-context-menu terminal-actions-menu" role="menu"
        aria-label="Terminal actions" style={{ left: Math.max(8, terminalContext.x), top: Math.max(8, terminalContext.y) }}
        onPointerDown={(event) => event.stopPropagation()} onKeyDown={menuNavigation}>
        <button role="menuitem" onClick={() => { setTerminalRename(terminalSessions.find((terminal) => terminal.id === terminalContext.id)); setTerminalContext(undefined) }}><Pencil size={14} />Rename…</button>
        <button role="menuitem" onClick={() => { setTerminalAction({ id: terminalContext.id, name: 'clear', sequence: Date.now() }); setTerminalContext(undefined) }}><ListTree size={14} />Clear output</button>
        <div role="separator" className="menu-separator" />
        <button role="menuitem" className="error-text" onClick={() => void closeTerminal(terminalContext.id)}><X size={14} />Close terminal…</button>
      </div>}
      {terminalRename && <TerminalNameDialog key={terminalRename.id} name={terminalRename.name} onClose={() => setTerminalRename(undefined)}
        onSave={async (name) => { await window.desktop.renameTerminal(terminalRename.id, name); await refreshTerminals() }} />}
      {settings && preferences && <PreferencesPanel
        preferences={preferences} runtime={runtime} onChange={(patch) => void updatePreferences(patch)}
        onClose={() => setSettings(false)} loadPlugins={loadGlobalPlugins}
      />}
      {workspaceInfo && <WorkspaceInfo key={workspaceInfo.path} workspace={preferences?.workspaces.find((workspace) => workspace.path === workspaceInfo.path) || workspaceInfo}
        onClose={() => setWorkspaceInfo(undefined)} loadPlugins={loadWorkspacePlugins}
        onRename={async (name) => { const next = await window.desktop.renameWorkspace(workspaceInfo.path, name); setPreferences(next); prefs.current = next }}
      />}
    </div>
  )
}
