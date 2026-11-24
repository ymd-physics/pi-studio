import { useCallback, useEffect, useState } from 'react'
import { ImageLightbox } from './ImageSurfaces'
import { useUiText } from './language'

export const isPreviewImage = (path: string) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(path)

export function FileImagePreview({ path, handle, revision }: { path: string; handle: string; revision: number }) {
  const t = useUiText(), name = path.split('/').at(-1) || path
  const [src, setSrc] = useState(''), [failed, setFailed] = useState(false), [expanded, setExpanded] = useState(false)
  const close = useCallback(() => setExpanded(false), [])
  useEffect(() => {
    let active = true
    window.desktop.readImageFile(path, handle).then(data => { if (active) { setFailed(false); setSrc(data) } }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [path, handle, revision])
  if (failed) return <p role="alert">{t('Cannot preview this image. Use the default application to open it.')}</p>
  if (!src) return <p role="status">{t('Loading image…')}</p>
  return <div className="file-preview file-image-preview">
    <button type="button" aria-label={t('Image: {name}', {name})} onClick={() => setExpanded(true)}>
      <img src={src} alt={name} onError={() => setFailed(true)} />
    </button>
    <ImageLightbox item={expanded ? {src, name, meta:''} : undefined} onClose={close} />
  </div>
}
