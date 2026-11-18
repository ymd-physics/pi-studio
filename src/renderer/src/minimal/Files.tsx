import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Folder, FileText, X } from 'lucide-react'
import type { FileEntry } from '../../../../packages/shared/desktop'
import { CodeBlock, Markdown } from './Markdown'
import { guessLangFromPath } from '../lib/shiki-highlighter'

export function Files({
  close,
  onDirty,
  handle,
  refreshKey = 0,
}: {
  close: () => void
  onDirty: (dirty: boolean) => void
  handle?: string
  refreshKey?: number
}) {
  const [directory, setDirectory] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [menu, setMenu] = useState<{ entry?: FileEntry; x: number; y: number }>()
  const [naming, setNaming] = useState<{
    type: 'rename' | 'create'
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
  const [saved, setSaved] = useState('')
  const [draft, setDraft] = useState('')
  const [revision, setRevision] = useState('')
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
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
    let active = true
    window.desktop
      .files(directory, handle)
      .then((data) => {
        if (active) setEntries(data)
      })
      .catch((e) => {
        if (active) setError(String(e))
      })
    return () => {
      active = false
    }
  }, [directory, refresh, handle, refreshKey])
  const discard = () => !dirty || window.confirm('Discard unsaved file changes?')
  const open = async (entry: FileEntry) => {
    if (saveActive.current || !discard()) return
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
    setReading(true)
    try {
      const result = await window.desktop.readFile(entry.path, handle)
      if (id !== generation.current) return
      setFile(entry.path)
      setSaved(result.content)
      setDraft(result.content)
      setRevision(result.revision)
      setEditing(false)
    } catch (e) {
      if (id === generation.current) setError(String(e))
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
    } catch (e) {
      setError(String(e))
    } finally {
      saveActive.current = false
      setSaving(false)
    }
  }
  const operate = async (action: string, entry?: FileEntry, newName?: string, folder = false) => {
    setMenu(undefined)
    if (saveActive.current || !handle) return
    const destructive = action === 'rename' || action === 'trash'
    if (destructive && !discard()) return
    saveActive.current = true
    setSaving(true)
    setError('')
    try {
      if (action === 'copy') await window.desktop.copyFile(handle, entry!.path)
      else if (action === 'paste')
        await window.desktop.pasteFiles(handle, entry?.isDirectory ? entry.path : directory)
      else {
        const result = await window.desktop.fileOperation(
          handle,
          action === 'create'
            ? { type: 'create', directory, name: newName!, folder }
            : action === 'rename'
              ? { type: 'rename', path: entry!.path, name: newName! }
              : { type: 'trash', path: entry!.path },
        )
        if (!result) return
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
  return (
    <aside
      className={`file-panel ${dragging ? 'drag-over' : ''}`}
      aria-label="Workspace files"
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
        <strong>Files</strong>
        <button
          className="icon-button"
          aria-label="Close files"
          onClick={() => {
            if (discard()) {
              onDirty(false)
              close()
            }
          }}
        >
          <X size={16} />
        </button>
      </div>
      <div className="file-location">
        <button
          className="icon-button"
          aria-label="Parent folder"
          disabled={!directory || saving}
          onClick={() =>
            void open({ name: '..', path: directory.split('/').slice(0, -1).join('/'), isDirectory: true })
          }
        >
          <ChevronLeft size={16} />
        </button>
        <span>{directory || 'Workspace'}</span>
      </div>
      <div
        className="file-list"
        onContextMenu={(e) => {
          e.preventDefault()
          if (!saving)
            setMenu({
              x: Math.min(e.clientX, window.innerWidth - 210),
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
                  x: Math.min(e.clientX, window.innerWidth - 210),
                  y: Math.min(e.clientY, window.innerHeight - 225),
                })
            }}
          >
            {entry.isDirectory ? <Folder size={14} /> : <FileText size={14} />}
            <span>{entry.name}</span>
          </button>
        ))}
      </div>
      {menu && (
        <div
          className="menu file-context-menu"
          role="menu"
          aria-label="File actions"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {menu.entry && (
            <>
              <button role="menuitem" onClick={() => void operate('copy', menu.entry)}>
                Copy
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setNaming({ type: 'rename', entry: menu.entry, name: menu.entry!.name })
                  setMenu(undefined)
                }}
              >
                Rename…
              </button>
              <button role="menuitem" onClick={() => void operate('trash', menu.entry)}>
                Move to Trash…
              </button>
            </>
          )}
          <button role="menuitem" onClick={() => void operate('paste', menu.entry)}>
            Paste{menu.entry?.isDirectory ? ' into folder' : ''}
          </button>
          {!menu.entry && (
            <>
              <button
                role="menuitem"
                onClick={() => {
                  setNaming({ type: 'create', folder: false, name: '' })
                  setMenu(undefined)
                }}
              >
                New file…
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setNaming({ type: 'create', folder: true, name: '' })
                  setMenu(undefined)
                }}
              >
                New folder…
              </button>
            </>
          )}
        </div>
      )}
      {naming && (
        <div className="modal-shade">
          <form
            className="dialog"
            role="dialog"
            aria-label={naming.type === 'rename' ? 'Rename file' : naming.folder ? 'New folder' : 'New file'}
            onSubmit={(e) => {
              e.preventDefault()
              void operate(naming.type, naming.entry, naming.name, naming.folder)
            }}
          >
            <h2>{naming.type === 'rename' ? 'Rename' : naming.folder ? 'New folder' : 'New file'}</h2>
            <input
              autoFocus
              aria-label="File name"
              required
              maxLength={180}
              disabled={saving}
              value={naming.name}
              onChange={(e) => setNaming({ ...naming, name: e.target.value })}
            />
            <div className="dialog-actions">
              <button type="button" disabled={saving} onClick={() => setNaming(undefined)}>
                Cancel
              </button>
              <button className="primary" disabled={saving || !naming.name.trim()}>
                Save
              </button>
            </div>
          </form>
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {file && (
        <div className="file-document">
          <div className="file-toolbar">
            <span title={file}>
              {file.split('/').at(-1)}
              {dirty ? ' •' : ''}
            </span>
            <button disabled={reading || saving} onClick={() => setEditing(!editing)}>
              {editing ? 'Preview' : 'Edit'}
            </button>
            <button disabled={!dirty || saving || reading} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          {editing ? (
            <textarea
              disabled={reading || saving}
              aria-label="File editor"
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
