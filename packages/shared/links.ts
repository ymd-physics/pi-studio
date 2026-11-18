/** Only these destinations may reach the desktop's explicit link handlers. */
export function linkKind(value: unknown): 'web' | 'local' | undefined {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return
  if (/^https?:\/\//i.test(value)) {
    try { const url = new URL(value); return url.hostname ? 'web' : undefined } catch { return }
  }
  if (value.startsWith('#') || value.startsWith('?') || value.startsWith('//') || value.includes('\\')) return
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value)
      if (url.hostname || url.username || url.password || !url.pathname.startsWith('/')) return
      return 'local'
    } catch { return }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return
  return 'local'
}

export interface LocalImagePreview {
  dataUrl?: string
  needsApproval?: boolean
}
