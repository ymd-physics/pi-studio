import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { useUiText } from './language'

export function SessionHistoryList({ children }: { children: ReactNode }) {
  const t = useUiText(), viewport = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState(0)
  useLayoutEffect(() => {
    const el = viewport.current!
    const update = () => setEdges((el.scrollTop > 1 ? 1 : 0) | (el.scrollHeight - el.clientHeight - el.scrollTop > 1 ? 2 : 0))
    const observer = new ResizeObserver(update)
    observer.observe(el); observer.observe(el.firstElementChild!)
    el.addEventListener('scroll', update, { passive: true }); update()
    return () => { observer.disconnect(); el.removeEventListener('scroll', update) }
  }, [])
  const Icon = edges === 1 ? ArrowUp : edges === 2 ? ArrowDown : ArrowUpDown
  const hint = t(edges === 1 ? 'Scroll up' : edges === 2 ? 'Scroll down' : 'Scroll up or down')
  return <div className="session-history-group">
    <div className="session-history-list" ref={viewport} role="region" aria-label={t('Other sessions')} tabIndex={0}><div>{children}</div></div>
    {!!edges && <div className="session-history-hint" role="img" aria-label={hint} title={hint}><Icon size={12} aria-hidden="true"/></div>}
  </div>
}
