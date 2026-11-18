import { test, expect, _electron as electron } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('web cards and native background notices remain read-only across history reload', async () => {
  const fixture = await createFixture({ completion: body => {
    const lastUser = body.messages?.filter(message => message.role === 'user').at(-1)
    if (!JSON.stringify(lastUser?.content).includes('web adaptation fixture')) return
    if (body.messages.at(-1)?.role === 'tool') return { delta: { content: 'Fixture research complete.' } }
    return { reason: 'tool_calls', delta: { tool_calls: ['web_search', 'source_check', 'fetch_content'].map((name, index) => ({ index, id: `web-fixture-${index}`, type: 'function', function: { name, arguments: JSON.stringify({ query: 'Web fixture' }) } })) } }
  } })
  let app
  try {
    await writeFile(join(fixture.agentDir, 'extensions/web-fixture.ts'), `
import { Type } from 'typebox';
export default function(pi) {
  const responses = {
    web_search: { content: [{ type: 'text', text: '**Provider:** fixture\\n\\nA provider-generated summary.\\n\\n**Sources:**\\n1. Example source\\n   https://example.com/source\\n\\n2. Second source\\n   https://example.org/docs' }], details: { queryCount: 2, successfulQueries: 1, totalResults: 2, fetchId: 'fixture-fetch', fetchUrls: ['https://example.com/source'], queryProviders: [{ query: 'Web fixture', providers: ['fixture'] }] } },
    source_check: { content: [{ type: 'text', text: 'Status: unclear. Review the cited material.' }], details: { sourceCount: 1, passageCount: 1, artifact: { sources: [{ title: 'Evidence source', url: 'https://example.com/evidence', quality: 'unknown', fetched: false }], passages: [{ passage_id: 'p-1-0', source_url: 'https://example.com/evidence', text: 'A generated claim summary, not a page quote.', origin: 'provider_summary' }], claims: [{ status: 'unclear', confidence: 0.3, rationale: 'Manual review required.' }] } } },
    fetch_content: { content: [{ type: 'text', text: '<script>window.WEB_MUST_NOT_RUN = true</script> raw page content' }], details: { urlCount: 1, successful: 1, totalChars: 76, mode: 'raw', urls: ['https://example.com'] } }
  };
  for (const name of Object.keys(responses)) pi.registerTool({ name, label: name, description: 'Offline web display fixture', parameters: Type.Object({ query: Type.Optional(Type.String()) }), execute: async (_id, _params, _signal, onUpdate) => {
    onUpdate?.({ content: [{type:'text',text:'Working…'}], details:{phase:'search',progress:0.5,currentQuery:'Web fixture'} });
    return responses[name];
  }});
  pi.registerCommand('web-fixture-notices', { handler: async () => {
    pi.sendMessage({customType:'web-search-content-ready',content:'Content fetched for 4/6 URLs [fixture-fetch]. Partial page content now available.',display:true}, {triggerTurn:false});
    pi.sendMessage({customType:'web-search-error',content:'Content fetch failed [fixture-error]: Fixture connection error',display:true}, {triggerTurn:false});
    pi.sendMessage({customType:'web-search-content-ready',content:'Future notice format retained verbatim.',display:true}, {triggerTurn:false});
  }});
}
`)
    app = await electron.launch({ args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'], executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE, env: fixture.env })
    const page = await app.firstWindow(), errors = []
    page.on('pageerror', error => errors.push(String(error)))
    const composer = page.getByRole('textbox', { name: 'Message Pi' })
    await expect(composer).toBeVisible()
    await composer.fill('web adaptation fixture'); await composer.press('Enter')
    await expect(page.getByText('Fixture research complete.', { exact: true })).toBeVisible()
    const group = page.getByRole('button', { name: '3 tool calls', exact: true })
    await expect(page.getByLabel('Tool execution status')).toContainText('Calls completed')
    await group.click()
    await page.getByRole('button', { name: /web_search.*succeeded/ }).click()
    await expect(page.getByLabel('Search the web')).toContainText('Partial results')
    await page.getByRole('button', { name: /example.com.*Example source.*Discovery link/ }).click()
    await expect(page.locator('.web-inspector')).toContainText('Opening this card does not fetch the page.')
    await page.getByRole('button', { name: /source_check.*succeeded/ }).click()
    await page.getByRole('button', { name: /Evidence source.*Not fetched/ }).click()
    await expect(page.getByLabel('Check sources')).toContainText('Provider summary · not page text')
    await page.getByRole('button', { name: /fetch_content.*succeeded/ }).click()
    await expect(page.getByLabel('Fetch content')).toContainText('<script>window.WEB_MUST_NOT_RUN = true</script>')
    expect(await page.evaluate(() => window.WEB_MUST_NOT_RUN)).toBeUndefined()
    await composer.fill('/web-fixture-notices'); await composer.press('Enter')
    await expect(page.locator('.web-coverage p')).toContainText('2 without retrieved content')
    await expect(page.getByText('Fixture connection error', { exact: true })).toBeVisible()
    await expect(page.getByText('Future notice format retained verbatim.', { exact: true })).toBeVisible()
    const snapshot = await page.evaluate(() => window.desktop.snapshot())
    const before = await readFile(snapshot.state.sessionFile, 'utf8'), requests = fixture.requests.length
    await composer.fill('keep this draft')
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark)
      for (const width of [1280, 760]) {
        await page.setViewportSize({ width, height: 900 })
        await page.getByLabel('Web access background update').first().scrollIntoViewIfNeeded()
        const notice = page.getByLabel('Web access background update').first()
        expect(await notice.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
        await notice.screenshot({ path: `test-results/studio-web-notice-${dark}-${width}.png` })
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    const searchToggle = page.getByRole('button', { name: /web_search.*succeeded/ })
    if (await searchToggle.getAttribute('aria-expanded') !== 'true') await searchToggle.click()
    await page.getByLabel('Search the web').scrollIntoViewIfNeeded()
    await page.getByLabel('Search the web').screenshot({ path: 'test-results/studio-web-sources.png' })
    await group.click(); await group.click()
    await expect(composer).toHaveValue('keep this draft')
    expect(fixture.requests.length).toBe(requests)
    expect(await readFile(snapshot.state.sessionFile, 'utf8')).toBe(before)
    await page.reload()
    await expect(page.locator('.web-coverage p')).toContainText('2 without retrieved content')
    await expect(page.getByText('Future notice format retained verbatim.', { exact: true })).toBeVisible()
    expect(fixture.requests.length).toBe(requests)
    expect(errors).toEqual([])
  } finally {
    if (app) { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {}); await app.close().catch(() => {}) }
    await fixture.dispose()
  }
})
