// Only unsent text belongs here; never persist pending attachments or send on restore.
export const draftKey = (workspace: string, file?: string) => file ? `pi:draft:${JSON.stringify([workspace, file])}` : ''
export function readDraft(key: string) {
  try { return key ? localStorage.getItem(key) || '' : '' } catch { return '' }
}
export function storeDraft(key: string, text: string) {
  if (!key) return
  try { if (text) localStorage.setItem(key, text); else localStorage.removeItem(key) } catch { /* In-memory editor remains available when storage is full. */ }
}
