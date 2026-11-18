import { test, expect, _electron as electron } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('typed subagent notices, draft-only guidance and docket navigation preserve native history', async () => {
  const fixture = await createFixture()
  let app
  try {
    const body = '当前仅有 read/grep/find/ls；read 对 PDF 返回压缩二进制，无法渲染 PDF 或解包 Office。请补充逐页文本、图片及文件清单；原始文件只读。'.repeat(6)
    const notices = [
      { customType: 'subagent_supervisor_request', content: `Subagent needs a supervisor decision.\nRun: fixture-run\n${body}\nReply with: subagent_supervisor({ action: "reply", replyTo: "fixture-request", message: "..." })`, details: { requestId: 'fixture-request', runId: 'fixture-run', agent: 'reviewer', childIndex: 0, reason: 'need_decision', expectsReply: true, requestBody: body } },
      { customType: 'subagent_supervisor_request', content: 'Structured interview fixture', details: { requestId: 'fixture-interview', runId: 'interview-run', agent: 'interviewer', childIndex: 0, reason: 'interview_request', expectsReply: true, requestBody: 'Confirm the scope and stopping condition.', interview: { scope: ['provided_only', 'request_more'] } } },
      { customType: 'subagent-supervisor-blocked', content: 'BLOCKED: unanswered supervisor request IDs: fixture-request', details: { blocked: true, requestIds: ['fixture-request'] } },
      { customType: 'subagent-notify', content: 'Native result preview and artifact path retained.', details: { runs: [{ agent: 'scout', status: 'completed' }, { agent: 'reviewer', status: 'failed' }] } },
      { customType: 'subagent_steering_notice', content: 'Steering partially delivered', details: { runId: 'fixture-run', state: 'partial', message: 'Inspect the run before retrying.' } },
      { customType: 'subagent_watchdog_warning', content: '<subagent_watchdog><summary>missing evidence</summary></subagent_watchdog>', details: { severity: 'concern', summary: 'Missing evidence', evidence: 'Two pages are unavailable.', recommendedAction: 'Qualify the conclusion.', stale: true } },
      { customType: 'subagent-workflow-result-write-failed', content: 'Artifact could not be saved. <script>window.NOTICE_UNSAFE = true</script>', details: {} },
      { customType: 'subagent_supervisor_request', content: 'Legacy request format remains available.', details: {} },
      { customType: 'subagent_future_notice', content: 'Future message remains visible.' },
      { customType: 'subagent_supervisor_request', content: 'HIDDEN NOTICE MUST NOT DISPLAY', display: false, details: { requestId: 'hidden', runId: 'fixture-run', agent: 'reviewer', childIndex: 0, reason: 'need_decision', expectsReply: true, requestBody: 'Hidden body' } },
    ]
    await writeFile(join(fixture.agentDir, 'extensions/notice-fixture.ts'), `export default function(pi) {
      pi.registerCommand('notice-fixture', { handler: async (_, ctx) => {
        for (const message of ${JSON.stringify(notices)}) pi.sendMessage({display:true,...message}, {triggerTurn:false});
        ctx.ui.setWidget('__pi_desktop_subagents_v1__', [JSON.stringify({availability:'available', updatedAt:Date.now(), agents:[
          {id:'foreground:fixture-run:1',name:'scout',state:'running',task:'Check document inventory',startedAt:Date.now()-29000},
          {id:'foreground:fixture-run:0',name:'reviewer',state:'waiting',task:'Review document evidence',startedAt:Date.now()-29000}
        ]})]);
      }});
    }`)
    app = await electron.launch({ args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'], executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE, env: fixture.env })
    const page = await app.firstWindow(), errors = []
    page.on('pageerror', error => errors.push(String(error)))
    const composer = page.getByRole('textbox', { name: 'Message Pi' })
    await expect(composer).toBeVisible()
    await composer.fill('/notice-fixture'); await composer.press('Enter')
    const request = page.getByRole('article', { name: 'reviewer needs a decision' })
    await expect(request).toBeAttached()
    await expect(page.locator('.subagent-notice')).toHaveCount(8)
    await expect(page.getByText('Future message remains visible.', { exact:true })).toBeAttached()
    await expect(page.getByText('HIDDEN NOTICE MUST NOT DISPLAY', { exact:true })).toHaveCount(0)
    await expect(request).not.toContainText('Reply with:')
    const snapshot = await page.evaluate(() => window.desktop.snapshot())
    const history = await readFile(snapshot.state.sessionFile, 'utf8'), requests = fixture.requests.length
    const shelf = page.getByRole('region', { name:'Subagent activity' })
    await shelf.getByRole('button', { name:'1 needs attention' }).click()
    await expect(shelf.locator('.subagent-focus-name')).toHaveText('reviewer')
    await expect(request).toBeFocused()
    await request.getByRole('button', { name:'Show full request' }).click()
    await expect(request.getByRole('button', { name:'Show less' })).toHaveAttribute('aria-expanded','true')
    await request.getByRole('button', { name:'Draft guidance to parent ↗' }).click()
    await expect(composer).toHaveValue("Regarding reviewer's request (fixture-request):\n")
    await expect(composer).toBeFocused()
    await composer.fill('Keep this unsent guidance.')
    await request.getByRole('button', { name:'Draft guidance to parent ↗' }).click()
    await expect(composer).toHaveValue('Keep this unsent guidance.')
    await request.locator('summary').click()
    await expect(request).toContainText('Reply with: subagent_supervisor')
    await request.locator('summary').click()
    await request.getByRole('button', { name:'Show less' }).click()
    for (const dark of [false,true]) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark)
      for (const width of [1280,760]) {
        await page.setViewportSize({ width,height:1000 })
        await shelf.getByRole('button', { name:'View recorded request ↑' }).click()
        expect(await request.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
        expect(await shelf.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
        await request.screenshot({ path:`test-results/subagent-notice-${dark}-${width}.png` })
      }
    }
    const failed = page.getByRole('article', { name:'Workflow result could not be saved' })
    await failed.locator('summary').click()
    await expect(failed).toContainText('<script>window.NOTICE_UNSAFE = true</script>')
    expect(await page.evaluate(() => window.NOTICE_UNSAFE)).toBeUndefined()
    expect(fixture.requests.length).toBe(requests)
    expect(await readFile(snapshot.state.sessionFile, 'utf8')).toBe(history)
    await page.reload()
    await expect(page.locator('.subagent-notice')).toHaveCount(8)
    await expect(request).toContainText('current resolution not inferred')
    await expect(page.getByRole('article', { name:'2 background runs finished' })).toContainText('1 failed')
    await expect(page.getByRole('article', { name:'Watchdog review' })).toContainText('Stale warning')
    expect(fixture.requests.length).toBe(requests)
    expect(errors).toEqual([])
  } finally {
    if (app) { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {}); await app.close().catch(() => {}) }
    await fixture.dispose()
  }
})
