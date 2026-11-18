import { useUiText } from './language'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ListTodo, Check, Circle, LoaderCircle } from 'lucide-react'
import type { TodoState } from '../../../../packages/shared/todo-state'
export function TodoButton({ state }: { state?: TodoState }) {
  const t = useUiText()
  const [open, setOpen] = useState(false)
  const control = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (open && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      if (!control.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    control.current?.addEventListener('keydown', escape)
    const element = control.current
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
      element?.removeEventListener('keydown', escape)
    }
  }, [open])
  const tasks = state?.tasks || []
  const label =
    !state || state.availability === 'unavailable'
      ? 'unavailable'
      : state.availability === 'disabled'
        ? 'disabled'
        : tasks.length
          ? `${tasks.filter((t) => t.status === 'completed').length}/${tasks.length}`
          : 'empty'
  return (
    <div className="todo-control" ref={control}>
      <button type="button" className="todo-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ListTodo size={14} />{' '}{t('Todo ({status})', { status: t(label) })}
      </button>
      {open && (
        <div className="todo-popover" role="region" aria-label={t("Session todo")}>
          <header>
            <strong>{t("Session tasks")}</strong>
            <button type="button" onClick={() => setOpen(false)} aria-label={t("Close todo")}>
              ×
            </button>
          </header>
          <div className="todo-scroll" ref={list}>
            {state?.availability === 'disabled' ? (
              <>
                <p>{t("rpiv-todo is not detected in this session. Install it in your terminal:")}</p>
                <code>{t("pi install npm:@juicesharp/rpiv-todo")}</code>
                <p>{t("Then run /reload here while Pi is idle.")}</p>
              </>
            ) : state?.availability !== 'enabled' ? (
              <p>{t("Task state is unavailable. Reload the session to retry.")}</p>
            ) : !tasks.length ? (
              <p>{t("No tasks yet. Tasks created by Pi will appear here.")}</p>
            ) : (
              <ul>
                {tasks.map((task) => (
                  <li key={task.id} className={`todo-${task.status}`}>
                    {task.status === 'completed' ? (
                      <Check size={15} />
                    ) : task.status === 'in_progress' ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <Circle size={13} />
                    )}
                    <div>
                      <span>
                        {task.status === 'in_progress' ? task.activeForm || task.subject : task.subject}
                      </span>
                      {task.description && <p>{task.description}</p>}
                      {!!task.blockedBy?.length && (
                        <small>{t("Depends on")}{' '}
                          {task.blockedBy
                            .map((id) => {
                              const dependency = tasks.find((t) => t.id === id)
                              return `#${id}${dependency ? ` ${dependency.subject} (${t(dependency.status)})` : ''}`
                            })
                            .join(', ')}
                        </small>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
