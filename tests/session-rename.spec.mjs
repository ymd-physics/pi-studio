import { test, expect, _electron as electron } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('sidebar rename preserves the selected conversation and draft for inactive and live targets', async () => {
  const fixture = await createFixture()
  let app
  try {
    app = await electron.launch({ args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'], executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE, env: fixture.env })
    const page = await app.firstWindow()
    const input = page.getByRole('textbox', { name: 'Message Pi' })
    await expect(input).toBeVisible()
    const original = await page.evaluate(() => window.desktop.snapshot())
    // Leave a real saved session inactive, rather than mocking session metadata.
    await page.getByRole('button', { name: 'New session in Research' }).click()
    await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.desktop.snapshot().then(s => s.handle))).not.toBe(original.handle)
    const current = await page.evaluate(() => window.desktop.snapshot())
    await expect(page.getByRole('button', { name: 'New session in Research' })).toBeEnabled()
    await page.evaluate(handle => window.desktop.closeSession(handle), original.handle)
    await input.fill('keep this unsent draft')
    const row = page.locator('.session-link:not(.terminal-link)').filter({ hasText: 'Discuss the harmonic oscillator' })
    await expect(row).toHaveAttribute('data-status', 'inactive')
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename session', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Rename session' })
    await expect(dialog).toBeVisible()
    expect((await page.evaluate(() => window.desktop.snapshot())).handle).toBe(current.handle)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await page.evaluate(() => window.desktop.runningSessions())).some(s => s.path === original.state.sessionFile)).toBe(false)
    for (const name of ['Background renamed', 'Live renamed']) {
      const target = page.locator('.session-link:not(.terminal-link)').filter({ hasText: name === 'Background renamed' ? 'Discuss the harmonic oscillator' : 'Background renamed' })
      await target.click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Rename session', exact: true }).click()
      await dialog.getByRole('textbox', { name: 'Session name' }).fill(name)
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.locator('.session-link').filter({ hasText: name })).toBeVisible()
      await expect(input).toHaveValue('keep this unsent draft')
      expect((await page.evaluate(() => window.desktop.snapshot())).handle).toBe(current.handle)
      const saved = JSON.parse(await readFile(join(fixture.dataDir, 'preferences.json'), 'utf8'))
      expect(saved.activeSession).toBe(current.state.sessionFile)
      expect(await readFile(original.state.sessionFile, 'utf8')).toContain(name)
    }
    await page.locator('.session-link').filter({ hasText: 'Live renamed' }).click()
    await expect(page.locator('.topbar:visible')).toContainText('Live renamed')
    await page.locator('.session-link.selected').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename session', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Session name' }).fill('Selected renamed')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.locator('.topbar:visible')).toContainText('Selected renamed')
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {})
      await app.close().catch(() => {})
    }
    await fixture.dispose()
  }
})
