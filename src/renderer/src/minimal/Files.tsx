import { useUiText } from './language'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, ChevronLeft, ClipboardPaste, Copy, ExternalLink, FilePlus, Folder, FolderOpen, FolderPlus, Link2, Pencil, Terminal, Trash2, X, type LucideIcon } from 'lucide-react'
import { FileImagePreview, isPreviewImage } from './FileImagePreview'
import { FilePageIcon } from './FilePageIcon'
import type { FileEntry } from '../../../../packages/shared/desktop'
import { CodeBlock, Markdown } from './Markdown'
import { guessLangFromPath } from '../lib/shiki-highlighter'

function menuItem(Icon: LucideIcon, label: string, click: () => void) {
  return <button role="menuitem" onClick={click}><Icon size={15} strokeWidth={1.6} aria-hidden="true"/><span>{label}</span></button>
}
const FilePdfPreview = lazy(() => import('./FilePdfPreview'))
const isPdf = (path: string) => /\.pdf$/i.test(path)
const readOnlyPreview = (path: string) => isPdf(path) || isPreviewImage(path)

export function Files({
  close,
  onDirty,
  handle,
  openTerminal,
  reference,
  refreshKey = 0,
  active = true,
}: {
  active?: boolean
  close: () => void
  onDirty: (dirty: boolean) => void
  handle?: string
  reference?: (path: string) => void
  openTerminal?: (directory: string) => Promise<void>
  refreshKey?: number
}) {
  const t = useUiText()
  const [directory, setDirectory] = useState('')
  const [listHeight, setListHeight] = useState<number>()
  const listRef = useRef<HTMLDivElement>(null)
  const dragOffset = useRef<number | null>(null)
  const parts = directory.split('/').filter(Boolean)
  const go = (path: string) => void open({ name: path, path, isDirectory: true })
  const [refresh, setRefresh] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [menu, setMenu] = useState<{ entry?: FileEntry; x: number; y: number }>()
  const [naming, setNaming] = useState<{
    type: 'rename' | 'create' | 'draftCopy'
    entry?: FileEntry
    folder?: boolean
    name: string
  }>()
  useEffect(() => {
    if (!menu) return
    const dismiss = () => setMenu(undefined)
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', dismiss)
    }
  }, [menu])
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [file, setFile] = useState('')
  const [unsupported, setUnsupported] = useState('')
  const [saved, setSaved] = useState('')
  const [draft, setDraft] = useState('')
  const [revision, setRevision] = useState('')
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState<{file: string; disk: string}>()
  const [saving, setSaving] = useState(false)
  const [reading, setReading] = useState(false)
  const generation = useRef(0)
  const saveActive = useRef(false)
  useEffect(
    () => () => {
      generation.current++
    },
    [],
  )
  const dirty = draft !== saved
  useEffect(() => {
    onDirty(dirty)
  }, [dirty, onDirty])
  useEffect(() => {
    if (!active) { setMenu(undefined); setNaming(undefined); setDragging(false); return }
    let current = true
    window.desktop
      .files(directory, handle)
      .then((data) => {
        if (current) setEntries(data)
      })
      .catch((e) => {
        if (current) setError(String(e))
      })
    return () => {
      current = false
    }
  }, [active, directory, refresh, handle, refreshKey])
  const discard = () => !dirty || window.confirm(t('Discard unsaved file changes?'))
  const open = async (entry: FileEntry) => {
    if (saveActive.current || !discard()) return
    setConflict(undefined)
    const id = ++generation.current
    setError('')
    setReading(false)
    if (entry.isDirectory) {
      setDirectory(entry.path)
      setFile('')
      setDraft('')
      setSaved('')
      return
    }
    if (readOnlyPreview(entry.path)) {
      setFile(entry.path); setSaved(''); setDraft(''); setRevision(''); setEditing(false)
      return
    }
    setReading(true)
    try {
      const result = await window.desktop.readFile(entry.path, handle)
      if (id !== generation.current) return
      setFile(entry.path)
      setUnsupported('')
      setSaved(result.content)
      setDraft(result.content)
      setRevision(result.revision)
      setEditing(false)
    } catch (e) {
      if (id !== generation.current) return
      if (/(?:^|: )binary$/.test(String(e))) {
        setUnsupported(entry.path); setFile(entry.path); setSaved(''); setDraft(''); setRevision(''); setEditing(false)
      } else setError(String(e))
    } finally {
      if (id === generation.current) setReading(false)
    }
  }
  const save = async () => {
    if (saveActive.current || reading || !dirty) return
    saveActive.current = true
    setSaving(true)
    setError('')
    try {
      setRevision(await window.desktop.saveFile(file, draft, revision, handle))
      setSaved(draft)
      setConflict(undefined)
    } catch (e) {
      if (String(e).includes('File changed on disk')) {
        try { const disk = await window.desktop.readFile(file, handle); setConflict({file, disk:disk.content}) }
        catch (readError) { setError(String(readError)) }
      } else setError(String(e))
    } finally {
      saveActive.current = false
      setSaving(false)
    }
  }
  const targetDirectory = (entry?: FileEntry) => entry?.isDirectory ? entry.path : directory
  const openFolderLabel = t(/Mac/.test(navigator.platform) ? 'Open in Finder' : 'Open folder externally')
  const operate = async (action: string, entry?: FileEntry, newName?: string, folder = false) => {
    setMenu(undefined)
    if (saveActive.current || !handle) return
    const destructive = action === 'rename' || action === 'trash'
    if (destructive && !discard()) return
    saveActive.current = true
    setSaving(true)
    setError('')
    try {
      if (action === 'openFolder') { await window.desktop.openFileExternally(handle, targetDirectory(entry)); return }
      if (action === 'external') { await window.desktop.openFileExternally(handle, entry!.path); return }
      if (action === 'copy') await window.desktop.copyFile(handle, entry!.path)
      else if (action === 'paste')
        await window.desktop.pasteFiles(handle, targetDirectory(entry))
      else {
        const result = await window.desktop.fileOperation(
          handle,
          action === 'draftCopy' ? {type:'create', directory:file.includes('/') ? file.slice(0,file.lastIndexOf('/')) : '', name:newName!, folder:false, content:draft} : action === 'create'
            ? { type: 'create', directory, name: newName!, folder }
            : action === 'rename'
              ? { type: 'rename', path: entry!.path, name: newName! }
              : { type: action === 'compress' || action === 'extract' ? action : 'trash', path: entry!.path },
        )
        if (!result) return
        if (action === 'draftCopy') {
          const copyPath = file.slice(0, file.lastIndexOf('/') + 1) + newName!
          const copy = await window.desktop.readFile(copyPath, handle)
          setFile(copyPath); setRevision(copy.revision); setSaved(copy.content); setConflict(undefined)
        }
        if (destructive) {
          generation.current++
          setReading(false)
          setFile('')
          setDraft('')
          setSaved('')
          onDirty(false)
        }
      }
      setNaming(undefined)
      setRefresh((value) => value + 1)
    } catch (e) {
      setError(String(e))
    } finally {
      saveActive.current = false
      setSaving(false)
    }
  }
  // Keep workspace-owned editor state, not a hidden preview DOM or filesystem subscription.
  if (!active) return null
  return (
    <aside
      className={`file-panel ${dragging ? 'drag-over' : ''}`}
      aria-label={t("Workspace files")}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (!handle || saving) return
        const paths = Array.from(e.dataTransfer.files)
          .map((f) => window.desktop.pathForFile(f))
          .filter(Boolean)
        if (!paths.length) return
        saveActive.current = true
        setSaving(true)
        setError('')
        void window.desktop
          .fileOperation(handle, { type: 'copy', paths, directory })
          .then(() => setRefresh((value) => value + 1))
          .catch((error) => setError(String(error)))
          .finally(() => {
            saveActive.current = false
            setSaving(false)
          })
      }}
    >
      <div className="panel-heading">
        <strong>{t("Files")}</strong>
        <div className="file-heading-actions">
          <button className="icon-button" disabled={!handle || saving} title={t('New file…')} aria-label={t('New file…')} onClick={() => setNaming({type:'create', folder:false, name:''})}><FilePlus size={15}/></button>
          <button className="icon-button" disabled={!handle || saving} title={t('New folder…')} aria-label={t('New folder…')} onClick={() => setNaming({type:'create', folder:true, name:''})}><FolderPlus size={15}/></button>
          <button className="icon-button" disabled={!handle || saving} title={openFolderLabel} aria-label={openFolderLabel} onClick={() => void operate('openFolder')}><FolderOpen size={15}/></button>
        <button
          className="icon-button"
          aria-label={t("Close files")}
          onClick={close}
        >
          <X size={16} />
        </button>
        </div>
      </div>
      <div className="file-location">
        <button
          className="icon-button"
          aria-label={t("Parent folder")}
          disabled={!directory || saving}
          onClick={() =>
            void open({ name: '..', path: directory.split('/').slice(0, -1).join('/'), isDirectory: true })
          }
        >
          <ChevronLeft size={16} />
        </button>
        <nav className="file-crumbs" aria-label={t('Folder path')}>
          <button disabled={!directory || saving} onClick={() => go('')}>{t('Workspace')}</button>
          {parts.length > 2 && <select aria-label={t('Parent folders')} value="" disabled={saving} onChange={e => go(e.target.value)}><option value="" disabled>…</option>{parts.slice(0,-2).map((name,i) => <option key={i} value={parts.slice(0,i+1).join('/')}>{name}</option>)}</select>}
          {parts.map((name,i) => i >= parts.length-2 && <button key={i} title={parts.slice(0,i+1).join('/')} disabled={saving || i===parts.length-1} onClick={() => go(parts.slice(0,i+1).join('/'))}>{name}</button>)}
        </nav>
      </div>
      <div
        ref={listRef} style={file && listHeight !== undefined ? {height:listHeight, maxHeight:'65%', flexShrink:0} : undefined}
        className="file-list"
        onContextMenu={(e) => {
          e.preventDefault()
          if (!saving)
            setMenu({
              x: Math.max(4, Math.min(e.clientX, window.innerWidth - 284)),
              y: Math.min(e.clientY, window.innerHeight - 225),
            })
        }}
      >
        {entries.map((entry) => (
          <button
            key={entry.path}
            className={file === entry.path ? 'selected' : ''}
            onClick={() => void open(entry)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (!saving)
                setMenu({
                  entry,
                  x: Math.max(4, Math.min(e.clientX, window.innerWidth - 284)),
                  y: Math.max(4, Math.min(e.clientY, window.innerHeight - 375)),
                })
            }}
          >
            {entry.isDirectory ? <Folder size={14} /> : <FilePageIcon name={entry.name} />}
            <span>{entry.name}</span>
          </button>
        ))}
      </div>
      {menu && (
        <div
          className="menu file-context-menu"
          role="menu"
          aria-label={t("File actions")}
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {menu.entry && !menu.entry.isDirectory && menuItem(ExternalLink, t('Open with default application'), () => void operate('external', menu.entry))}
          {menuItem(FolderOpen, menu.entry && !menu.entry.isDirectory ? t(/Mac/.test(navigator.platform) ? 'Open containing folder in Finder' : 'Open containing folder') : openFolderLabel, () => void operate('openFolder', menu.entry))}
          {openTerminal && menuItem(Terminal, t(menu.entry && !menu.entry.isDirectory ? 'New terminal in containing folder' : 'New terminal here'), () => { setMenu(undefined); void openTerminal(targetDirectory(menu.entry)) })}
          <hr role="separator"/>
          {menu.entry && reference && menuItem(Link2, t('Reference in current conversation'), () => { reference(menu.entry!.path); setMenu(undefined) })}
          {menu.entry && menuItem(Copy, t('Copy'), () => void operate('copy', menu.entry))}
          {menuItem(ClipboardPaste, t('Paste') + (menu.entry?.isDirectory ? t(' into folder') : ''), () => void operate('paste', menu.entry))}
          {menu.entry && (
            <>
              {menuItem(Pencil, t('Rename…'), () => { setNaming({type:'rename', entry:menu.entry, name:menu.entry!.name}); setMenu(undefined) })}
              <hr role="separator"/>
              {menuItem(ArrowDownToLine, t('Compress to ZIP'), () => void operate('compress', menu.entry))}
              {!menu.entry.isDirectory && /\.zip$/i.test(menu.entry.name) && menuItem(ArrowUpFromLine, t('Extract ZIP here'), () => void operate('extract', menu.entry))}
              <hr role="separator"/>
              {menuItem(Trash2, t('Move to Trash…'), () => void operate('trash', menu.entry))}
            </>
          )}

          {!menu.entry && (
            <>
              {menuItem(FilePlus, t('New file…'), () => { setNaming({type:'create', folder:false, name:''}); setMenu(undefined) })}
              {menuItem(FolderPlus, t('New folder…'), () => { setNaming({type:'create', folder:true, name:''}); setMenu(undefined) })}
            </>
          )}
        </div>
      )}
      {naming && (
        <div className="modal-shade">
          <form
            className="dialog"
            role="dialog"
            aria-label={naming.type === 'draftCopy' ? t('Save draft as…') : naming.type === 'rename' ? t('Rename file') : naming.folder ? t('New folder') : t('New file')}
            onSubmit={(e) => {
              e.preventDefault()
              void operate(naming.type, naming.entry, naming.name, naming.folder)
            }}
          >
            <h2>{naming.type === 'draftCopy' ? t('Save draft as…') : naming.type === 'rename' ? t('Rename') : naming.folder ? t('New folder') : t('New file')}</h2>
            <input
              autoFocus
              aria-label={t("File name")}
              required
              maxLength={180}
              disabled={saving}
              value={naming.name}
              onChange={(e) => setNaming({ ...naming, name: e.target.value })}
            />
            <div className="dialog-actions">
              <button type="button" disabled={saving} onClick={() => setNaming(undefined)}>{t("Cancel")}</button>
              <button className="primary" disabled={saving || !naming.name.trim()}>{t("Save")}</button>
            </div>
          </form>
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {conflict && conflict.file === file && <section className="file-conflict" aria-label={t('File changed on disk')}>
        <strong>{t('File changed on disk')}</strong>
        <details><summary>{t('Compare versions')}</summary><b>{t('On disk')}</b><pre>{conflict.disk}</pre><b>{t('My draft')}</b><pre>{draft}</pre></details>
        <button disabled={saving} onClick={() => { const base=file.split('/').at(-1)!; const dot=base.lastIndexOf('.'); setNaming({type:'draftCopy',name:dot>0 ? base.slice(0,dot)+'-draft'+base.slice(dot) : base+'-draft'}) }}>{t('Save draft as…')}</button>
      </section>}
      {file && <div className="file-split" role="separator" aria-label={t('Resize file preview')} aria-orientation="horizontal" tabIndex={0}
        title={t('Drag to resize; double-click to reset')} onDoubleClick={() => setListHeight(undefined)}
        onPointerDown={e => { if (e.button !== 0 || !listRef.current) return; dragOffset.current=e.clientY-listRef.current.offsetHeight; e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={e => { if (dragOffset.current !== null) setListHeight(Math.max(80, e.clientY-dragOffset.current)) }}
        onLostPointerCapture={() => { dragOffset.current=null }} onKeyDown={e => {
          if (e.key === 'Home') setListHeight(undefined)
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') setListHeight(Math.max(80,(listRef.current?.offsetHeight || 80)+(e.key==='ArrowUp'?-24:24)))
          else return
          e.preventDefault()
        }} />}
      {file && (
        <div className="file-document">
          <div className="file-toolbar">
            <span title={file}>
              {file.split('/').at(-1)}
              {dirty ? ' •' : ''}
            </span>
            {unsupported !== file && !readOnlyPreview(file) && <><button disabled={reading || saving} onClick={() => setEditing(!editing)}>
              {editing ? t('Preview') : t('Edit')}
            </button>
            <button disabled={!dirty || saving || reading} onClick={() => void save()}>
              {saving ? t('Saving…') : t('Save')}
            </button></>}
            <button className="icon-button" aria-label={t('Close file')} title={t('Close file')} disabled={saving} onClick={() => {
              if (saveActive.current || !discard()) return
              generation.current++; setReading(false); setFile(''); setDraft(''); setSaved(''); setRevision(''); setEditing(false); setError('')
            }}><X size={14} /></button>
          </div>
          {unsupported === file ? <div className="file-no-preview">
            <p role="status">{t('Pi Studio can’t preview this file format.')}</p>
            <button disabled={!handle || saving} onClick={() => void operate('external', {path:file, name:file.split('/').at(-1)!, isDirectory:false})}><ExternalLink size={14} aria-hidden="true"/> {t('Open with default application')}</button>
          </div> : isPdf(file) ? handle && <Suspense fallback={<p role="status">{t('Loading PDF…')}</p>}><FilePdfPreview key={`${handle}:${file}`} path={file} handle={handle}/></Suspense> : isPreviewImage(file) ? handle && <FileImagePreview key={`${handle}:${file}`} path={file} handle={handle} /> : editing ? (
            <textarea
              disabled={reading || saving}
              aria-label={t("File editor")}
              className="file-editor"
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault()
                  void save()
                }
              }}
            />
          ) : (
            <div className="file-preview">
              {/\.md$/i.test(file) ? (
                <Markdown text={draft} origin={handle ? { handle, baseDir: file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '' } : undefined} />
              ) : (
                <CodeBlock code={draft} language={guessLangFromPath(file)} />
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
