import { useEffect, useRef, useState } from 'react'

export function TerminalNameDialog({ name: initialName, onSave, onClose }: {
  name: string
  onSave(name: string): Promise<void>
  onClose(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(initialName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="dialog terminal-name-dialog" aria-label="Rename terminal"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
    <form onSubmit={async (event) => {
      event.preventDefault()
      if (busy || !name.trim()) return
      setBusy(true)
      try { await onSave(name.trim()); onClose() }
      catch (error) { setError(error instanceof Error ? error.message : String(error)); setBusy(false) }
    }}>
      <h2>Rename terminal</h2>
      <label htmlFor="terminal-name">Name</label>
      <input id="terminal-name" aria-label="Terminal name" autoFocus maxLength={160} value={name}
        onChange={(event) => setName(event.target.value)} disabled={busy} />
      <p className="muted">Only the label changes. The shell and its tasks keep running.</p>
      {error && <p role="alert" className="error-text">{error}</p>}
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  </dialog>
}
