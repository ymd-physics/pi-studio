import { useMemo, useState } from 'react'
import { Globe, ChevronRight, X } from 'lucide-react'
import type { Message } from '../../../../packages/shared/desktop'
import type { ToolState } from './presentation'
import { MarkdownLink } from './MarkdownLinks'
import { backgroundNotice, count, record, text, webSources, webText, webUrl } from './web-access'
import './web-access.css'

function metadata(value: unknown): string {
  let budget = 24000
  const seen = new WeakSet<object>()
  const visit = (item: unknown, depth: number): unknown => {
    if (budget <= 0 || depth > 6) return '[preview limited]'
    budget -= 16
    if (typeof item === 'string') { const result = item.slice(0, Math.max(0, Math.min(3000, budget))); budget -= result.length; return result }
    if (!item || typeof item !== 'object') return item
    if (seen.has(item)) return '[repeated reference]'
    seen.add(item)
    if (Array.isArray(item)) return item.slice(0, 64).map(value => visit(value, depth + 1))
    return Object.fromEntries(Object.entries(item).slice(0, 64).map(([key, value]) => [key.slice(0, 200), visit(value, depth + 1)]))
  }
  return JSON.stringify(visit(value, 0), null, 2) || ''
}
function NativeData({ args, result, initialOpen = false }: { args?: unknown; result?: Message; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  return <details className="web-native" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Native data · {args === undefined ? 'original notification' : 'arguments & result'}</summary>
    {open && <><p>Bounded display only. Full native data remains in the session.</p>
      {args !== undefined && <pre>{metadata({ arguments: args })}</pre>}
      <pre>{webText(result) || 'No text result available.'}</pre>
      {result?.details && <pre>{metadata(result.details)}</pre>}
      {result?.customType && <small>{result.customType}</small>}
    </>}
  </details>
}
export function WebBackgroundNotice({ message }: { message: Message }) {
  const notice = backgroundNotice(message)
  if (!notice) return null
  const partial = notice.kind === 'ready' && notice.available < notice.total
  return <section className="web-card web-background" aria-label="Web access background update">
    <div className="web-eyebrow">WEB ACCESS / BACKGROUND UPDATE</div>
    <div className="web-heading"><strong>{notice.kind === 'error' ? 'Background fetch failed' : 'Background content'}</strong>
      <span className={notice.kind === 'error' || (notice.kind === 'ready' && !notice.available) ? 'web-error' : partial ? 'web-warning' : 'web-success'}>{notice.kind === 'error' ? 'Error' : !notice.available ? 'No content' : partial ? 'Partial' : 'Ready'}</span></div>
    {notice.kind === 'ready' ? <><div className="web-coverage"><div>{notice.available} <small>/ {notice.total}</small></div><p><strong>Pages ready to read</strong>{partial ? `${notice.total - notice.available} without retrieved content` : 'All pages in this batch are available'}</p></div>
      <div className="web-coverage-bar" aria-hidden="true"><span style={{ width: `${100 * notice.available / notice.total}%` }} /></div>
      <p>Background fetch finished. URL-level diagnostics are not included in this notice.</p></> : <p>{notice.error}</p>}
    <NativeData result={message} />
  </section>
}
export function WebToolResult({ name, args, result, status }: { name: string; args: unknown; result?: Message; status: ToolState }) {
  const details = record(result?.details), arguments_ = record(args)
  const content = useMemo(() => webText(result), [result])
  const sources = useMemo(() => webSources(name, details, content), [name, result, content])
  const [selected, setSelected] = useState<string>()
  const source = sources.find(item => item.url === selected)
  const active = status === 'running' || status === 'pending'
  const error = text(details.error) || (result?.isError ? 'The tool reported an error.' : '')
  const query = text(arguments_.query) || text(arguments_.claim) || (Array.isArray(arguments_.queries) ? arguments_.queries.slice(0, 8).map(value => text(value, 500)).filter(Boolean).join(' · ') : '')
  const queryCount = count(details.queryCount), successfulQueries = count(details.successfulQueries)
  const urlCount = count(details.urlCount), successful = count(details.successful)
  const partialSearch = queryCount !== undefined && successfulQueries !== undefined && successfulQueries < queryCount
  const partialFetch = urlCount !== undefined && successful !== undefined && successful < urlCount
  const phase = text(details.phase, 80)
  const review = ['curating', 'waiting-for-approval', 'curator-fallback'].includes(phase)
  const progress = typeof details.progress === 'number' && Number.isFinite(details.progress) && details.progress >= 0 && details.progress <= 1 ? details.progress : undefined
  const curatorUrl = webUrl(details.curatorUrl)
  const artifact = record(details.artifact)
  const claims = Array.isArray(artifact.claims) ? artifact.claims.slice(0, 8).map(record) : []
  const recognized = active || !!error || sources.length > 0 || queryCount !== undefined || urlCount !== undefined || count(details.contentLength) !== undefined || Object.keys(artifact).length > 0
  const label = active ? review ? 'Needs your review' : status === 'pending' ? 'Waiting' : phase === 'generating-summary' ? 'Generating summary' : 'Working' : status === 'failed' || error ? 'Failed' : partialSearch || partialFetch ? 'Partial results' : name === 'source_check' ? 'Collected' : 'Completed'
  const tone = status === 'failed' || error ? 'web-error' : review || partialSearch || partialFetch ? 'web-warning' : active ? '' : 'web-success'
  const names: Record<string, string> = { web_search: 'Search the web', fetch_content: 'Fetch content', get_search_content: 'Read stored content', source_check: 'Check sources' }
  return <section className="web-card" aria-label={names[name] || 'Web access result'}>
    <header className="web-heading"><Globe size={15} /><strong>{names[name] || name}</strong><span className={tone}>{label}</span></header>
    {query && <p className="web-query">{query}</p>}
    {active ? <div className={`web-notice ${review ? 'web-review' : ''}`}>
      <p>{review ? 'Review and approve in the plugin’s browser curator. This is not a final result.' : text(details.currentQuery) || (status === 'pending' ? 'Waiting to execute…' : 'Waiting for the tool’s next update…')}</p>
      {progress !== undefined && !review && <><progress aria-label="Reported phase progress" max={1} value={progress} /><small>Reported phase progress · not time remaining</small></>}
      {review && curatorUrl && <MarkdownLink href={curatorUrl}>Open browser review ↗</MarkdownLink>}
      {review && count(details.timeoutSeconds) !== undefined && <small>Reported idle timeout: {String(details.timeoutSeconds)} s · not a live countdown</small>}
      {text(details.browserOpenError) && <p className="web-warning">{text(details.browserOpenError)}</p>}
    </div> : <>
      {error && <p className="web-notice web-error">{error}</p>}
      <div className="web-meta">
        {queryCount !== undefined && <span>{successfulQueries !== undefined ? `${successfulQueries} / ` : ''}{queryCount} queries</span>}
        {count(details.totalResults) !== undefined && <span>{String(details.totalResults)} results</span>}
        {urlCount !== undefined && <span>{successful !== undefined ? `${successful} / ` : ''}{urlCount} URLs fetched</span>}
        {count(details.totalChars) !== undefined && <span>{String(details.totalChars)} characters</span>}
        {text(details.mode, 30) && <span>Mode: {text(details.mode, 30)}</span>}
        {text(details.mimeType, 100) && <span>{text(details.mimeType, 100)}</span>}
        {count(details.sourceCount) !== undefined && <span>{String(details.sourceCount)} sources</span>}
        {count(details.passageCount) !== undefined && <span>{String(details.passageCount)} passages</span>}
      </div>
      {(partialSearch || partialFetch) && <p className="web-notice web-warning">Some results are unavailable. Available content is retained; this is not an all-success result.</p>}
      {name === 'web_search' && typeof details.fetchId === 'string' && <p className="web-notice">{Array.isArray(details.fetchUrls) ? 'Background fetching was started. Availability is reported in separate updates.' : 'Stored page content is available. Search snippets remain distinct from page text.'}</p>}
      {name === 'source_check' && <div className="web-notice web-review">
        {claims.length ? claims.map((claim, index) => <div key={index}><strong>{text(claim.status, 80) || 'Assessment unavailable'} · source assessment</strong><p>{text(claim.rationale, 3000) || 'Review the source passages manually.'}</p></div>) : <p>No claim assessment supplied. Review the evidence manually.</p>}
        <small>Tool completion is not verification of the claim. Source types are classifications, not trust scores.</small>
      </div>}
      {sources.length > 0 && <><div className="web-source-grid">{sources.map(item => <button key={item.url} aria-pressed={selected === item.url} className="web-source" onClick={() => setSelected(selected === item.url ? undefined : item.url)}>
        <small>{new URL(item.url).hostname}</small><strong>{item.title}</strong><span>{item.fetched === true ? 'Page fetched' : item.fetched === false ? 'Not fetched' : 'Discovery link'} <ChevronRight size={11} /></span>
      </button>)}</div>
      {source && <div className="web-inspector"><div className="web-heading"><strong>{source.title}</strong><button aria-label="Close source preview" onClick={() => setSelected(undefined)}><X size={14} /></button></div>
        <MarkdownLink href={source.url}>{source.url}</MarkdownLink>
        {source.quality && <p>Type: {source.quality} · not a credibility rating</p>}
        {source.passage ? <><small className="web-warning">{source.origin} {source.passageId && `· ${source.passageId}`}</small><blockquote>{source.passage}</blockquote></> : <p>No page passage was supplied with this result. Opening this card does not fetch the page.</p>}
      </div>}<small className="web-limit">Up to 24 unique source cards. Full returned results remain in native data.</small></>}
      {name === 'get_search_content' && count(details.contentLength) !== undefined && <div className="web-notice"><strong>Stored content</strong><p>{count(details.offset) !== undefined && count(details.returnedChars) !== undefined ? `Chars ${details.offset}–${Number(details.offset) + Number(details.returnedChars)} of ${details.contentLength}` : `${details.contentLength} characters in the stored source`}{details.truncated === true ? ' · more content available' : ''}</p><small>Character offsets, not tokens. Viewing this card does not retrieve another slice.</small></div>}
      {(name === 'fetch_content' || name === 'get_search_content') && content && <pre className="web-page-content">{content}</pre>}
      {name === 'web_search' && content && <details className="web-returned"><summary>Returned summary & source text</summary><p>Search-provider output; not a verified page quotation. Any approved summary metadata remains in native data.</p><pre>{content}</pre></details>}
    </>}
    {!recognized && <p className="web-limit">Unrecognized or older result format. Original output is shown below.</p>}
    <NativeData key={recognized ? 'adapted' : 'native'} args={args} result={result} initialOpen={!recognized} />
  </section>
}
