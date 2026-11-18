import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type MouseEvent } from 'react'
import { ExternalLink, Image as ImageIcon } from 'lucide-react'
import { linkKind, type LocalImagePreview } from '../../../../packages/shared/links'
import './markdown-links.css'

export type MarkdownLocation = { handle: string; baseDir?: string }
export const MarkdownOrigin = createContext<MarkdownLocation | undefined>(undefined)

export function MarkdownLink({ href, children }: { href?: string; children: ReactNode }) {
  const origin = useContext(MarkdownOrigin)
  const [error, setError] = useState('')
  const kind = linkKind(href)
  if (!href || !kind || (kind === 'local' && !origin)) return <span>{children}</span>
  const open = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    event.stopPropagation() // App's HTTP-only fallback must not handle this a second time.
    setError('')
    try {
      if (kind === 'web') await window.desktop.openExternal(href)
      else await window.desktop.openLocalLink(origin!.handle, href, origin!.baseDir)
    } catch (e) { setError(String(e)) }
  }
  return <>
    <a href={href} title={href} rel="noopener noreferrer" onClick={open} onAuxClick={e => { if (e.button === 1) void open(e) }}>{children}</a>
    {error && <span className="markdown-link-error" role="status">{error}</span>}
  </>
}

export function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const origin = useContext(MarkdownOrigin)
  const holder = useRef<HTMLSpanElement>(null)
  const generation = useRef(0)
  const [near, setNear] = useState(false)
  const [height, setHeight] = useState(0)
  useEffect(() => setHeight(0), [src, origin?.handle, origin?.baseDir])
  const [preview, setPreview] = useState<LocalImagePreview>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const local = linkKind(src) === 'local'
  useEffect(() => {
    if (!holder.current) return
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return }
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: '250px' })
    observer.observe(holder.current)
    return () => observer.disconnect()
  }, [])
  const load = async (requestApproval = false) => {
    if (!src || !origin || !local) return
    const id = ++generation.current
    setLoading(true)
    setError('')
    try {
      const value = await window.desktop.previewLocalImage(origin.handle, src, origin.baseDir, requestApproval)
      if (id === generation.current) setPreview(value)
    } catch (e) { if (id === generation.current) setError(String(e)) }
    finally { if (id === generation.current) setLoading(false) }
  }
  useEffect(() => {
    generation.current++
    setPreview(undefined)
    setError('')
    setLoading(false)
    if (near) void load()
    return () => { generation.current++ }
  }, [near, src, origin?.handle, origin?.baseDir])
  return <span className="markdown-image" ref={holder}>
    {preview?.dataUrl ? <img src={preview.dataUrl} alt={alt || 'Local image'} decoding="async" onLoad={e => setHeight(e.currentTarget.getBoundingClientRect().height)} /> :
      <span className="markdown-image-placeholder" style={height ? { height } : undefined}><ImageIcon size={18} />{alt || 'Image'}</span>}
    <span className="markdown-image-caption">
      {preview?.dataUrl && alt && <span>{alt}</span>}
      {src && <MarkdownLink href={src}><ExternalLink size={12} /> Open original</MarkdownLink>}
      {loading ? <span>Loading preview…</span> : preview?.needsApproval ?
        <button type="button" onClick={() => void load(true)}>Load image outside workspace</button> :
        !local ? <span>Remote image not loaded automatically</span> : !origin ? <span>Open a session to preview</span> : null}
    </span>
    {error && <span className="markdown-link-error" role="status">{error}</span>}
  </span>
}
