import { useEffect, useRef, useState } from 'react'
import { getDocument, PDFWorker, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useUiText } from './language'

// Render just the current page to a canvas. No scripts, form controls or annotation editor.
export default function FilePdfPreview({ path, handle, revision }: { path: string; handle: string; revision: number }) {
  const t = useUiText(), canvas = useRef<HTMLCanvasElement>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy>(), [page, setPage] = useState(1), [error, setError] = useState(false)
  useEffect(() => {
    let live = true, stop: (() => void) | undefined
    setError(false); setDoc(undefined)
    void window.desktop.readPdfFile(path, handle).then(async data => {
      if (!live) return
      const port = new Worker(workerUrl, {type:'module'}), worker = PDFWorker.create({port})
      const base = new URL('./pdf-assets/', document.baseURI).href
      const loading = getDocument({data, worker, cMapUrl:base+'cmaps/',standardFontDataUrl:base+'standard_fonts/', wasmUrl:base+'wasm/',iccUrl:base+'iccs/', useWorkerFetch:false, maxImageSize:32*1024*1024})
      stop = () => { void loading.destroy().finally(() => {worker.destroy(); port.terminate()}).catch(() => {}) }
      const pdf = await loading.promise
      if (live) { setPage(p => Math.min(p, pdf.numPages)); setDoc(pdf) }
    }).catch(() => { if (live) setError(true) })
    return () => { live = false; stop?.() }
  }, [path,handle,revision])
  useEffect(() => {
    if (!doc || !canvas.current) return
    let live = true, task: RenderTask | undefined
    const target = canvas.current
    void doc.getPage(page).then(async p => {
      if (!live) return
      const unit = p.getViewport({scale:1}), viewport = p.getViewport({scale:Math.min(2,1600/Math.max(unit.width,unit.height))})
      target.width = Math.max(1,Math.ceil(viewport.width)); target.height = Math.max(1,Math.ceil(viewport.height))
      task = p.render({canvas:target,viewport}); await task.promise
    }).catch(() => { if (live) setError(true) })
    return () => { live=false; task?.cancel() }
  }, [doc,page])
  if (error) return <p role="alert">{t('Cannot preview this PDF. Open it with the default application.')}</p>
  if (!doc) return <p role="status">{t('Loading PDF…')}</p>
  return <><div className="file-toolbar"><button disabled={page===1} onClick={()=>setPage(p=>p-1)}>{t('Previous page')}</button><span>{page} / {doc.numPages}</span><button disabled={page===doc.numPages} onClick={()=>setPage(p=>p+1)}>{t('Next page')}</button></div>
    <div className="file-preview"><canvas key={page} ref={canvas} aria-label={t('PDF preview')} style={{display:'block',width:'100%',height:'auto'}} /></div></>
}
