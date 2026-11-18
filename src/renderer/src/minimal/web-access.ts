import type { Message } from '../../../../packages/shared/desktop'
import { stripAnsi } from '../../../../packages/shared/ansi'

export const WEB_TOOLS = ['web_search', 'fetch_content', 'get_search_content', 'source_check'] as const
export const isWebTool = (name?: string) => WEB_TOOLS.some(tool => tool === name)
export const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const text = (value: unknown, limit = 2000): string => typeof value === 'string' ? stripAnsi(value).slice(0, limit) : ''
export const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
export function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) return
  try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return value } catch { /* native text fallback */ }
}
export function webText(message?: Message): string {
  const content = message?.content
  // Bound work as well as rendered output; remote results are not trusted metadata.
  if (typeof content === 'string') return text(content, 30000)
  if (!Array.isArray(content)) return ''
  let output = ''
  for (const item of content.slice(0, 128)) {
    if (item?.type === 'text' && typeof item.text === 'string') output += text(item.text, 30000 - output.length) + '\n'
    if (output.length >= 30000) break
  }
  return output.slice(0, 30000)
}
export interface WebSource { url: string; title: string; fetched?: boolean; quality?: string; passage?: string; origin?: string; passageId?: string }
export function webSources(name: string, details: Record<string, unknown>, content: string): WebSource[] {
  const sources: WebSource[] = []
  const append = (value: unknown) => {
    const item = record(value), url = webUrl(item.url)
    if (!url || sources.length >= 24 || sources.some(source => source.url === url)) return
    sources.push({ url, title: text(item.title, 300) || new URL(url).hostname,
      fetched: typeof item.fetched === 'boolean' ? item.fetched : undefined, quality: text(item.quality, 80) || undefined })
  }
  if (name === 'source_check') {
    const artifact = record(details.artifact)
    if (Array.isArray(artifact.sources)) artifact.sources.slice(0, 64).forEach(append)
    const passages = Array.isArray(artifact.passages) ? artifact.passages.slice(0, 128).map(record) : []
    for (const source of sources) {
      const passage = passages.find(item => item.source_url === source.url && typeof item.text === 'string')
      if (passage) {
        source.passage = text(passage.text, 3000)
        source.origin = passage.origin === 'provider_summary' ? 'Provider summary · not page text' : record(passage.extraction_span).start !== undefined ? 'Extracted page passage' : 'Search snippet · not verified page text'
        source.passageId = text(passage.passage_id, 80)
      }
    }
  } else if (name === 'web_search') {
    if (Array.isArray(details.curatedQueries)) for (const query of details.curatedQueries.slice(0, 32)) {
      const items = record(query).sources
      if (Array.isArray(items)) items.slice(0, 64).forEach(append)
    }
    // Only the plugin's known numbered Sources format, not arbitrary links in prose.
    if (content.includes('**Sources:**')) {
      const section = content.slice(content.indexOf('**Sources:**'))
      for (const match of section.matchAll(/(?:^|\n)\d+\. ([^\n]+)\n[ \t]+(https?:\/\/[^\s]+)/g)) append({ title: match[1], url: match[2] })
    }
  }
  return sources
}
export type BackgroundNotice = { kind: 'ready'; available: number; total: number; id: string } | { kind: 'error'; id: string; error: string }
export function backgroundNotice(message: Message): BackgroundNotice | undefined {
  const content = webText(message).trim()
  if (message.customType === 'web-search-content-ready') {
    const match = /^Content fetched for (\d+)\/(\d+) URLs \[([\w-]{1,128})\]\. (Full page content now available\.|Partial page content now available\.|No page content was fetched\. Stored fetch diagnostics are available\.)$/.exec(content)
    if (!match) return
    const available = count(Number(match[1])), total = count(Number(match[2]))
    if (available === undefined || total === undefined || total === 0 || available > total) return
    if ((available === total ? 'Full' : available > 0 ? 'Partial' : 'No') !== match[4].split(' ')[0]) return
    return { kind: 'ready', available, total, id: match[3] }
  }
  if (message.customType === 'web-search-error') {
    const match = /^Content fetch failed \[([\w-]{1,128})\]: ([\s\S]+)$/.exec(content)
    if (match) return { kind: 'error', id: match[1], error: match[2] }
  }
}
