import { useUiText } from './language'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Image as ImageIcon, X } from 'lucide-react'
import type { ContentBlock } from '../../../../packages/shared/desktop'
import { thumbnailSize, type ImageThumbnail, type ImageThumbnailSize } from '../../../../packages/shared/images'
import {
  formatBytes,
  imageBytes,
  imageDataUrl,
  type FileAttachment,
  type MessageImage,
  type ToolImage,
} from './attachments'

export interface LightboxImage {
  src: string
  name: string
  meta: string
}

type OpenImage = (image: LightboxImage) => void

interface Thumb {
  src: string
  width?: number
  height?: number
  failed?: boolean
}

function thumbnailApi() {
  return typeof window === 'undefined' ? undefined : window.desktop?.imageThumbnail
}

function useThumbnailSize(frame: HTMLSpanElement | null): ImageThumbnailSize | undefined {
  const [size, setSize] = useState<ImageThumbnailSize>()
  useEffect(() => {
    if (!frame) return
    const measure = () => {
      const width = frame.clientWidth, height = frame.clientHeight
      // Hidden sessions should not request a new decode on every window resize.
      if ((!width || !height) && typeof ResizeObserver !== 'undefined') return
      const next = thumbnailSize(width || 128, height || 78, window.devicePixelRatio)
      setSize((old) => old?.width === next.width && old?.height === next.height ? old : next)
    }
    let density: MediaQueryList | undefined
    const watchDensity = () => {
      density?.removeEventListener('change', densityChanged)
      if (typeof window.matchMedia !== 'function') return
      density = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      density.addEventListener('change', densityChanged)
    }
    function densityChanged() {
      measure()
      watchDensity()
    }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    resize?.observe(frame)
    window.addEventListener('resize', measure)
    measure()
    watchDensity()
    return () => {
      resize?.disconnect()
      window.removeEventListener('resize', measure)
      density?.removeEventListener('change', densityChanged)
    }
  }, [frame])
  return size
}

function useThumbnail(block: ContentBlock, enabled: boolean, size?: ImageThumbnailSize): Thumb {
  const api = thumbnailApi()
  const [state, setState] = useState<Thumb>({ src: '' })
  useEffect(() => {
    if (!enabled || !size) return
    if (!api) {
      setState({ src: imageDataUrl(block) })
      return
    }
    let alive = true
    setState({ src: '' })
    void api(block.data || '', block.mimeType || 'image/png', size)
      .then((thumb: ImageThumbnail | null) => {
        if (!alive) return
        setState(
          thumb
            ? { src: thumb.dataUrl, width: thumb.width, height: thumb.height }
            : { src: '', failed: true },
        )
      })
      .catch(() => {
        if (alive) setState({ src: '', failed: true })
      })
    return () => {
      alive = false
    }
  }, [api, enabled, block.data, block.mimeType, size?.width, size?.height])
  return state
}

function imageMeta(image: MessageImage, thumb: Thumb): string {
  const dimensions = thumb.width && thumb.height ? `${thumb.width} × ${thumb.height}` : ''
  const size = formatBytes(imageBytes(image.block))
  const count = image.total > 1 ? `${image.index + 1} / ${image.total}` : ''
  return [dimensions, size, count].filter(Boolean).join(' · ')
}

function ImageCard({
  image,
  scope,
  onOpen,
}: {
  image: MessageImage
  scope: 'attachment' | 'tool'
  onOpen: OpenImage
}) {
  const t = useUiText()
  const card = useRef<HTMLButtonElement>(null)
  const [frame, setFrame] = useState<HTMLSpanElement | null>(null)
  const size = useThumbnailSize(frame)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const element = card.current
    if (!element) return
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setNear(true)
        observer.disconnect()
      },
      { rootMargin: '300px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const thumb = useThumbnail(image.block, near, size)
  const meta = imageMeta(image, thumb)
  const open = () =>
    onOpen({
      src: imageDataUrl(image.block),
      name: image.name,
      meta: [meta, scope === 'tool' ? 'tool result' : 'attachment'].filter(Boolean).join(' · '),
    })
  const caption = (
    <>
      <span className="image-frame" ref={setFrame}>
        {thumb.src ? (
          <img src={thumb.src} alt={image.name} loading="lazy" decoding="async" />
        ) : (
          <span className="image-placeholder" aria-hidden="true">
            <ImageIcon size={18} />
          </span>
        )}
      </span>
      <span className="image-caption">
        <strong title={image.path || image.name}>{image.name}</strong>
        {thumb.failed ? <small>{t("Preview unavailable")}</small> : meta && <small>{meta}</small>}
      </span>
    </>
  )
  if (thumb.failed)
    return (
      <div
        className={`image-card image-card-${scope} image-card-unavailable`}
        role="group"
        title={image.path || image.name}
        aria-label={t('{name} preview unavailable', { name: image.name })}
      >
        {caption}
      </div>
    )
  return (
    <button
      ref={card}
      type="button"
      className={`image-card image-card-${scope}`}
      disabled={!thumb.src}
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true })
        open()
      }}
      title={t('Open {name}', { name: image.name })}
      aria-label={t('Open {name}', { name: image.name })}
    >
      {caption}
    </button>
  )
}

export function UserAttachments({
  images,
  files,
  handle,
  onOpen,
}: {
  images: MessageImage[]
  files: FileAttachment[]
  handle?: string
  onOpen: OpenImage
}) {
  const t = useUiText()
  const pathKey = files.map((file) => file.path).join('\n')
  const [sizes, setSizes] = useState<Record<string, number | null>>({})
  useEffect(() => {
    if (!handle || !files.length) return
    const api = typeof window === 'undefined' ? undefined : window.desktop?.fileSizes
    if (!api) return
    let alive = true
    void api(handle, files.map((file) => file.path))
      .then((next) => {
        if (alive) setSizes(next)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [handle, pathKey])
  if (!images.length && !files.length) return null
  return (
    <div className="message-attachments">
      {!!images.length && (
        <div className="image-grid user-image-grid" role="group" aria-label={t("Attached images")}>
          {images.map((image) => (
            <ImageCard key={image.key} image={image} scope="attachment" onOpen={onOpen} />
          ))}
        </div>
      )}
      {!!files.length && (
        <div className="file-grid" role="group" aria-label={t("Attached files")}>
          {files.map((file, index) => (
            <div className="file-card" key={`${file.path}:${index}`} title={file.path}>
              <span className="file-icon" aria-hidden="true">
                <FileText size={16} />
              </span>
              <span className="file-meta">
                <strong>{file.name}</strong>
                <small>
                  {[
                    file.extension === 'FILE' ? 'File' : `${file.extension} file`,
                    formatBytes(sizes[file.path] || 0),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ToolImageGrid({
  images,
  onOpen,
}: {
  images: ToolImage[]
  onOpen: OpenImage
}) {
  const t = useUiText()
  if (!images.length) return null
  return (
    <div className="image-grid tool-images" role="group" aria-label={t("Tool result images")}>
      {images.map((image) => (
        <ImageCard key={image.key} image={image} scope="tool" onOpen={onOpen} />
      ))}
    </div>
  )
}

export function ImageLightbox({ item, onClose }: { item?: LightboxImage; onClose: () => void }) {
  const t = useUiText()
  const close = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [naturalWidth, setNaturalWidth] = useState(0)
  const [zoom, setZoom] = useState(0) // 0 fits the preview; other values are percentages of the original.
  useEffect(() => { if (!item) { setZoom(0); setNaturalWidth(0) } }, [item])
  useEffect(() => {
    if (!item) return
    const previous = document.activeElement as HTMLElement | null
    close.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
      if (event.key === 'Tab') {
        const items = [
          ...(panel.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
          ) || []),
        ]
        if (!items.length) return
        const first = items[0],
          last = items.at(-1)!
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus({ preventScroll: true })
    }
  }, [item, onClose])
  if (!item) return null
  return createPortal(
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t('Image: {name}', { name: item.name })}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="image-lightbox-panel" ref={panel}>
        <header>
          <span>
            <strong>{item.name}</strong>
            {item.meta && <small>{item.meta}</small>}
          </span>
          {!!naturalWidth && <select className="image-zoom" aria-label={t('Image zoom')} title={t('Image zoom')} value={zoom} onChange={e => setZoom(Number(e.target.value))}>
            <option value={0}>{t('Fit image')}</option>
            {[50, 100, 150, 200].map(percent => <option key={percent} value={percent}>{percent}%</option>)}
          </select>}
          <button
            ref={close}
            type="button"
            className="image-lightbox-close icon-button"
            aria-label={t("Close image")}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="image-preview-area"><img src={item.src} alt={item.name}
          onLoad={e => setNaturalWidth(e.currentTarget.naturalWidth)}
          style={zoom ? {width: naturalWidth * zoom / 100, maxWidth: 'none', maxHeight: 'none'} : undefined} /></div>
      </div>
    </div>,
    document.body,
  )
}
