import { useUiText } from './language'
import { useEffect, useRef, useState } from 'react'
import { ListTodo, Check, Circle, LoaderCircle, ChevronRight } from 'lucide-react'
import type { TodoSummary, TodoTask } from '../../../../packages/shared/todo-state'

type Group = 'active' | 'completed'
function TaskRows({ handle, revision, group, count }: { handle: string; revision: string; group: Group; count: number }) {
  const t = useUiText()
  const [rows, setRows] = useState<TodoTask[]>([])
  const [offset, setOffset] = useState(0)
  const [retry, setRetry] = useState(0)
  const [error, setError] = useState(false)
  const more = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (offset >= count) return
    let live = true
    setError(false)
    window.desktop.command('desktop_todo_page', { revision, group, offset }, handle).then((page: TodoTask[]) => {
      if (!live) return
      if (!page.length) { setError(true); return }
      setRows(old => [...old.slice(0, offset), ...page])
    }).catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [handle, revision, group, offset, retry, count])
  const hasMore = rows.length > offset && rows.length < count
  useEffect(() => {
    const el = more.current
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) setOffset(rows.length)
    }, { root: el.closest('.todo-scroll') })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, rows.length])
  return <>
    <ul>{rows.map(task => <li key={task.id} className={`todo-${task.status}`}>
      {task.status === 'completed' ? <Check size={15} /> : task.status === 'in_progress' ? <LoaderCircle className="spin" size={15} /> : <Circle size={13} />}
      <div><span>{task.status === 'in_progress' ? task.activeForm || task.subject : task.subject}</span>
        {task.description && <p>{task.description}</p>}
        {!!task.blockedBy?.length && <small>{t('Depends on')} {task.blockedBy.map(id => `#${id}`).join(', ')}</small>}
      </div>
    </li>)}</ul>
    {hasMore && <button ref={more} onClick={() => setOffset(rows.length)}>{t('Load more tasks')}</button>}
    {error && <button onClick={() => setRetry(n => n + 1)}>{t('Retry')}</button>}
    {!error && offset < count && rows.length === offset && <small role="status">{t('Loading tasks…')}</small>}
  </>
}

export function TodoButton({ state, handle }: { state: TodoSummary; handle: string }) {
  const t = useUiText()
  const [open, setOpen] = useState(false)
  const [completed, setCompleted] = useState(false)
  const control = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => { if (!control.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
    }
  }, [open])
  return <div className="todo-control" ref={control} onKeyDown={e => {
    if (open && e.key === 'Escape') { e.stopPropagation(); setOpen(false); toggle.current?.focus() }
  }}>
    <button ref={toggle} type="button" className="todo-toggle" aria-expanded={open} onClick={() => { setCompleted(false); setOpen(!open) }}>
      <ListTodo size={14} /> {t('Todo ({status})', { status: state.total ? `${state.completed}/${state.total}` : t('empty') })}
    </button>
    {open && <div className="todo-popover" role="region" aria-label={t('Session todo')}>
      <header><strong>{t('Session tasks')}</strong><button onClick={() => { setOpen(false); toggle.current?.focus() }} aria-label={t('Close todo')}>×</button></header>
      <div className="todo-scroll">
        {!state.total && <p>{t('No tasks yet. Tasks created by Pi will appear here.')}</p>}
        {state.total > state.completed && <TaskRows key={`active:${state.revision}`} handle={handle} revision={state.revision} group="active" count={state.total - state.completed} />}
        {state.completed > 0 && <button className="todo-done-toggle" aria-expanded={completed} onClick={() => setCompleted(!completed)}>
          <ChevronRight size={14} />{t('Completed ({count})', { count: state.completed })}
        </button>}
        {completed && state.completed > 0 && <TaskRows key={`done:${state.revision}`} handle={handle} revision={state.revision} group="completed" count={state.completed} />}
      </div>
    </div>}
  </div>
}
