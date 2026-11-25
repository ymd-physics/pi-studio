import { useEffect, useRef, useState } from 'react'
import { useUiText } from './language'

export function SessionNameDialog({ name: initialName, onSave, onClose }: {
  name: string
  onSave(name: string): Promise<void>
  onClose(): void
}) {
  const t = useUiText()
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(initialName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="dialog session-name-dialog" aria-label={t('Rename session')}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
    <form onSubmit={async (event) => {
      event.preventDefault()
      if (busy || !name.trim()) return
      setBusy(true)
      setError('')
      try { await onSave(name.trim()); onClose() }
      catch (error) { setError(String(error).replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, '')); setBusy(false) }
    }}>
      <h2>{t('Rename conversation')}</h2>
      <input aria-label={t('Session name')} autoFocus maxLength={200} required value={name}
        onChange={(event) => setName(event.target.value)} disabled={busy} />
      {error && <p role="alert" className="error-text">{error}</p>}
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
        <button className="primary" disabled={busy || !name.trim()}>{busy ? t('Saving…') : t('Save')}</button>
      </div>
    </form>
  </dialog>
}
