import { expect, it } from 'vitest'
import { backgroundNotice, webSources, webText, webUrl } from './web-access'

it('adapts only exact, consistent background notifications with bounded references', () => {
  const message = { role: 'custom', customType: 'web-search-content-ready', content: 'Content fetched for 4/6 URLs [abc]. Partial page content now available.' }
  expect(backgroundNotice(message)).toEqual({ kind: 'ready', available: 4, total: 6, id: 'abc' })
  expect(backgroundNotice({ ...message, customType: 'other' })).toBeUndefined()
  for (const content of [message.content.replace('4/6', '7/6'), message.content.replace('4/6', '0/0'), message.content.replace('Partial', 'Full'), 'Unknown upgraded notice', message.content.replace('4/6', '9007199254740992/9007199254740993')]) expect(backgroundNotice({ ...message, content })).toBeUndefined()
  expect(backgroundNotice({ ...message, content: 'Content fetched for 0/6 URLs [abc]. No page content was fetched. Stored fetch diagnostics are available.' })).toMatchObject({ available: 0, total: 6 })
  expect(backgroundNotice({ role: 'custom', customType: 'web-search-error', content: 'Content fetch failed [abc]: timed out' })).toEqual({ kind: 'error', id: 'abc', error: 'timed out' })
})
it('rejects active/credential URLs and preserves exact safe URLs', () => {
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'https://user:password@example.com/', 'https://example.com\n', 'data:text/html,hi', '//example.com']) expect(webUrl(url)).toBeUndefined()
  expect(webUrl('https://example.com/a?q=1')).toBe('https://example.com/a?q=1')
})
it('reads only supported source layouts, caps cards and keeps provenance', () => {
  const body = '**Sources:**\n1. Title\n   https://example.com/a\n\n2. Duplicate\n   https://example.com/a'
  expect(webSources('web_search', {}, body)).toEqual([{ title: 'Title', url: 'https://example.com/a', fetched: undefined, quality: undefined }])
  expect(webSources('web_search', {}, body.replace('**Sources:**', 'Arbitrary text:'))).toEqual([])
  const artifact = { sources: [{ title: 'Source', url: 'https://example.com', quality: 'unknown', fetched: false }], passages: [{ source_url: 'https://example.com', text: 'generated passage', origin: 'provider_summary', passage_id: 'p1' }] }
  expect(webSources('source_check', { artifact }, '')[0]).toMatchObject({ origin: 'Provider summary · not page text', fetched: false, passageId: 'p1' })
  const many = Array.from({ length: 100 }, (_, i) => ({ title: String(i), url: `https://example.com/${i}` }))
  expect(webSources('source_check', { artifact: { sources: many } }, '')).toHaveLength(24)
  expect(webSources('source_check', { artifact: { sources: [null, false, { url: 'javascript:alert(1)' }] } }, '')).toEqual([])
})
it('bounds text and leaves image payloads outside web parsing', () => {
  expect(webText({ role: 'toolResult', content: [{ type: 'image', data: 'secret', mimeType: 'image/png' }, { type: 'text', text: 'a'.repeat(50000) }] })).toHaveLength(30000)
  expect(webText({ role: 'toolResult', content: '\x1b[31mhello\x1b[0m' })).toBe('hello')
})
