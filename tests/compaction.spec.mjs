import { test, expect, _electron as electron } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('native compaction shows progress, extension messages, estimated counts and cancellation', async () => {
  const fixture = await createFixture()
  let app
  try {
    await writeFile(
      join(fixture.agentDir, 'extensions/custom-compaction.ts'),
      `export default function(pi) {
      pi.on('session_before_compact', async (event,ctx) => {
        ctx.ui.setStatus('custom-compressor','Custom compressor: preparing checkpoint');
        if(event.customInstructions === 'cancel') {
          ctx.ui.notify('Custom compressor: request refused', 'error');
          return {cancel:true};
        }
        await ctx.ui.confirm('Continue fixture compaction?', 'Verify progress before confirming');
        return {compaction:{summary:'Summary supplied by the custom compressor.',tokensBefore:123456,firstKeptEntryId:event.preparation.firstKeptEntryId}};
      });
      pi.on('session_compact', (_,ctx) => ctx.ui.notify('Custom compressor: checkpoint saved', 'info'));
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
    await input.fill('More context before compaction')
    await input.press('Enter')
    await expect.poll(() => fixture.requests.length).toBe(2)
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0)
    await page.locator('.session-link.selected').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Compact context' }).click()
    await expect(page.locator('.compaction-notice.running')).toContainText('Compacting…')
    await expect(page.locator('.compaction-notice.running')).toContainText(
      'Custom compressor: preparing checkpoint',
    )
    await expect(page.getByText('Pi is working', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    const completed = page.locator('.compaction-notice.complete')
    await expect(completed).toHaveCount(1)
    await expect(completed).toContainText('123,456')
    await expect(completed).toContainText(/≈ [\d,]+/)
    await expect(completed).toContainText('Pi estimate')
    await expect(completed).toContainText('Custom compressor: checkpoint saved')
    await completed.locator('summary').click()
    await expect(completed).toContainText('Summary supplied by the custom compressor.')
    await page.screenshot({ path: 'test-results/compaction-complete.png' })
    await input.fill('Continue after compaction')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0)
    await input.fill('/compact cancel')
    await input.press('Enter')
    await expect(page.locator('.compaction-notice.cancelled')).toContainText('Compaction cancelled')
    await expect(page.locator('.compaction-notice.cancelled')).toContainText(
      'Custom compressor: request refused',
    )
    expect((await page.evaluate(() => window.desktop.runningSessions()))[0].status).toBe('active')
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
      await app.close()
    }
    await fixture.dispose()
  }
})
