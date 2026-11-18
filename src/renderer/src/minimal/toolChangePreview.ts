export type ChangeLine = { kind: 'added' | 'deleted' | 'context'; number: string; text: string }
export type ChangePreview = { lines: ChangeLine[]; truncated: boolean }
export const previewLimit = 30000
const lineLimit = 300
const columnLimit = 1000

function preview(text: string, nativeDiff: boolean, kind: ChangeLine['kind']): ChangePreview | undefined {
  const sample = text.slice(0, previewLimit)
  const rawLines = sample.split('\n')
  // A character-budget cut may split a native line header; do not treat that as malformed data.
  if (nativeDiff && text.length > previewLimit && rawLines.length > 1) rawLines.pop()
  const lines: ChangeLine[] = []
  let truncated = text.length > previewLimit || rawLines.length > lineLimit
  for (const [index, raw] of rawLines.slice(0, lineLimit).entries()) {
    let line: ChangeLine
    if (nativeDiff) {
      // Pi's native diff has a sign followed by a padded source line number.
      const match = /^([+\- ])\s*(\d+) (.*)$/.exec(raw)
      if (match) {
        line = { kind: match[1] === '+' ? 'added' : match[1] === '-' ? 'deleted' : 'context', number: match[2], text: match[3] }
      } else if (/^\s*…\s*$/.test(raw) || /^\s*\.\.\.\s*$/.test(raw) || raw === '') {
        line = { kind: 'context', number: '', text: raw }
      } else {
        return undefined
      }
    } else {
      line = { kind, number: String(index + 1), text: raw }
    }
    if (line.text.length > columnLimit) {
      line.text = line.text.slice(0, columnLimit) + '…'
      truncated = true
    }
    lines.push(line)
  }
  return { lines, truncated }
}

export function parseNativeDiff(value: unknown): ChangePreview | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return preview(value, true, 'context')
}

export function contentPreview(value: string, kind: ChangeLine['kind'] = 'added'): ChangePreview {
  return preview(value, false, kind)!
}

/** Submitted write length, not a diff. Count CRLF once and do not invent a trailing empty line. */
export function countContentLines(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  if (!value.length) return 0
  let lines = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\n') lines++
    else if (value[i] === '\r') {
      lines++
      if (value[i + 1] === '\n') i++
    }
  }
  return lines + (value.endsWith('\n') || value.endsWith('\r') ? 0 : 1)
}

export function boundedDiagnostic(value: unknown): string {
  const text = JSON.stringify(value, (_key, item) =>
    typeof item === 'string' && item.length > previewLimit
      ? item.slice(0, previewLimit) + '… [truncated]'
      : item, 2) ?? 'Unavailable'
  return text.slice(0, previewLimit) + (text.length > previewLimit ? '\n… [truncated]' : '')
}
