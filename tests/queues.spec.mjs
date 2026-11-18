import { test, expect, _electron as electron } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('native steering, follow-up, recall and compaction command overrides', async () => {
  const fixture = await createFixture()
  let app
  try {
    await writeFile(
      join(fixture.agentDir, 'extensions/compact-override.ts'),
      `export default function(pi) {
      pi.registerCommand('compact', {description:'Custom compaction', handler:async (_,ctx)=>{ctx.ui.notify('Custom compaction handled', 'info')}})
    }`,
    )
    app = await electron.launch({
      args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
      executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
      env: fixture.env,
    })
    const page = await app.firstWindow()
    const input = page.getByRole('textbox', { name: 'Message Pi' })
    await expect(input).toBeVisible()
    await page.locator('.session-link.selected').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Compact context' }).click()
    // The compaction panel can also mirror this native notification.
    await expect(page.locator('.session-notice').getByText('Custom compaction handled', { exact: true })).toBeVisible()
    await input.fill('slow tool')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop generation' })).toBeVisible()
    await input.fill('please adjust course')
    await input.press('Enter')
    await expect(page.locator('.pending-messages')).toContainText('please adjust course')
    await input.fill('next question after completion')
    await input.press('Alt+Enter')
    await expect(page.locator('.pending-messages')).toContainText('next question after completion')
    await page.getByRole('button', { name: 'Recall all' }).click()
    await expect(page.locator('.pending-messages')).toHaveCount(0)
    await expect
      .poll(async () => (await input.inputValue()).trim())
      .toBe('please adjust course\n\nnext question after completion')
    await page.getByRole('button', { name: 'Stop generation' }).click()
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0)
    const requestsBefore = fixture.requests.length
    await input.fill('grouped tools')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop generation' })).toBeVisible()
    await input.fill('Steering delivered')
    await input.press('Enter')
    await input.fill('Follow-up delivered')
    await input.press('Alt+Enter')
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0, { timeout: 15000 })
    await expect(page.locator('.pending-messages')).toHaveCount(0)
    const sent = fixture.requests.slice(requestsBefore).map((r) => JSON.stringify(r.messages))
    expect(sent.some((s) => s.includes('Steering delivered'))).toBe(true)
    expect(sent.at(-1)).toContain('Follow-up delivered')
    expect(sent.some((s) => s.includes('please adjust course'))).toBe(false)
    await writeFile(
      join(fixture.agentDir, 'extensions/compact-override.ts'),
      `export default function(pi) {
      pi.on('session_before_compact', async (_,ctx)=> {ctx.ui.notify('Native compact hook reached','info'); return {cancel:true}})
    }`,
    )
    await input.fill('/reload')
    await input.press('Enter')
    await expect(page.getByText('Pi resources reloaded. Session history preserved.')).toBeVisible()
    await input.fill('/compact')
    await input.press('Enter')
    await expect(page.getByLabel('Compaction').getByText('Native compact hook reached')).toBeVisible()
    await expect(page.locator('.session-notice.notice-error').last()).toContainText('cancelled')
    await input.fill('Session survives compaction refusal')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0)
    await expect
      .poll(() =>
        fixture.requests
          .at(-1)
          ?.messages?.some((m) => JSON.stringify(m.content).includes('Session survives compaction refusal')),
      )
      .toBe(true)
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
      await app.close()
    }
    await fixture.dispose()
  }
})
