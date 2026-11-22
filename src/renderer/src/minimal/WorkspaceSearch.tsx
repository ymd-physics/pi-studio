import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { SessionInfo, Workspace } from '../../../../packages/shared/desktop'
import { useUiText } from './language'

export function WorkspaceSearch({ workspace, open, close }: { workspace: Workspace; open(path: string, term?: string, snippet?: string): void; close(): void }) {
  const t = useUiText()
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SessionInfo[]>()
  const [error, setError] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    if (!query.trim()) return
    let current = true
    const timer = setTimeout(() => { window.desktop.sessions(workspace.path, query.trim()).then(items => {
      if (current) setResults(items)
    }).catch(e => { if (current) setError(String(e)) }) }, 220)
    return () => { current = false; clearTimeout(timer) }
  }, [workspace.path, query])
  return <dialog ref={dialog} className="dialog workspace-search" aria-label={t('Search sessions in {name}', { name:workspace.name })} onCancel={close}>
    <header><span>{t('Search sessions in {name}', { name: workspace.name })}</span><button className="icon-button" aria-label={t('Close search')} onClick={close}><X size={16}/></button></header>
    <label><Search size={16}/><input type="search" autoFocus value={query} placeholder={t('Search session titles and messages')} aria-label={t('Search session titles and messages')} onChange={e => { setResults(undefined); setError(''); setQuery(e.target.value) }} /></label>
    {error ? <p role="alert">{error}</p> : query.trim() && !results?.length ? <p role="status">{results ? t('No matches in {name}', { name: workspace.name }) : t('Searching…')}</p> : null}
    <div className="workspace-search-results">{results?.map(item => {
      const title = item.name || item.firstMessage || t('Untitled conversation')
      const text = item.matchSnippet || title
      const term = query.trim()
      const at = text.toLowerCase().indexOf(term.toLowerCase())
      return <button key={item.path} onClick={() => open(item.path, item.matchSnippet ? term : undefined, item.matchSnippet)}>
        <span title={text}>{at < 0 ? text : <>{text.slice(0, at)}<mark>{text.slice(at, at + term.length)}</mark>{text.slice(at + term.length)}</>}</span>
        {item.matchSnippet && <small title={title}><span aria-hidden="true">↳ </span>{title}</small>}
      </button>
    })}</div>
  </dialog>
}
