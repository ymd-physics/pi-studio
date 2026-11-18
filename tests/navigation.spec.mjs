import { test, expect, _electron as electron } from '@playwright/test'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('native branching, compaction, workspace navigation and bounded long transcripts', async () => {
  const fixture = await createFixture()
  let app
  try {
    app = await electron.launch({
      args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
      executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
      env: fixture.env,
    })
    const page = await app.firstWindow()
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    await page.evaluate(() => {
      window.confirm = () => true
    })
    const input = page.getByRole('textbox', { name: 'Message Pi' })
    await expect(input).toBeVisible()
    const before = await page.evaluate(() => window.desktop.snapshot())
    const original = await readFile(before.state.sessionFile, 'utf8')
    await page.locator('.session-link.selected').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Fork from message…' }).click()
    await page
      .getByRole('dialog', { name: 'Branch conversation' })
      .getByRole('button', { name: /Discuss the harmonic oscillator/ })
      .click()
    await expect(input).toHaveValue('Discuss the harmonic oscillator')
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessionFile).not.toBe(
      before.state.sessionFile,
    )
    await input.fill('Explore a new branch')
    await input.press('Enter')
    await expect(page.getByText('The native Pi session is connected.', { exact: false })).toBeVisible()
    expect(await readFile(before.state.sessionFile, 'utf8')).toBe(original)
    await page.locator('.session-link.selected').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Session tree', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Session tree' })).toBeVisible()
    await page.getByRole('button', { name: 'Close branches' }).click()
    await input.fill('One more step before compaction')
    await input.press('Enter')
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.desktop.snapshot())).messages.filter(
            (m) => m.role === 'assistant',
          ).length,
      )
      .toBe(2)
    await input.fill('/compact')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0)
    const entries = await page.evaluate(() => window.desktop.command('get_entries'))
    expect(entries.entries.some((entry) => entry.type === 'compaction')).toBe(true)
    await input.fill('Please large tool')
    await input.press('Enter')
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.desktop.snapshot())).messages.filter(
            (m) => m.role === 'toolResult',
          ).length,
      )
      .toBe(1)
    await page.getByRole('button', { name: '1 tool call', exact: true }).click()
    await page.getByRole('button', { name: /bash.*printf.*succeeded/ }).click()
    await expect(page.getByText('… Output preview limited', { exact: false })).toBeVisible()
    await input.fill('/long-history')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: /Show earlier messages/ })).toBeAttached()
    expect(await page.locator('.message').count()).toBeLessThanOrEqual(100)
    await page.getByRole('button', { name: /Show earlier messages/ }).click()
    await expect(page.getByText('History item 0', { exact: true })).toBeAttached()
    const other = join(fixture.root, 'other-workspace')
    await mkdir(other)
    await writeFile(join(other, 'keep.txt'), 'keep')
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    }, other)
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await page.getByRole('button', { name: 'New session in other-workspace' }).click()
    await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click()
    await expect(page.locator('.session-view:visible .breadcrumbs')).toContainText('other-workspace')
    await input.fill('Second workspace prompt')
    await input.press('Enter')
    await expect(
      page
        .locator('.session-view:visible')
        .getByText('The native Pi session is connected.', { exact: false }),
    ).toBeVisible()
    const second = await page.evaluate(() => window.desktop.snapshot())
    expect(second.workspace).toBe(other)
    expect(JSON.parse((await readFile(second.state.sessionFile, 'utf8')).split('\n')[0]).cwd).toBe(other)
    await page.getByRole('button', { name: 'Remove other-workspace' }).click()
    await expect(page.getByRole('button', { name: 'Remove other-workspace' })).toHaveCount(0)
    expect(await readFile(join(other, 'keep.txt'), 'utf8')).toBe('keep')
    expect(await readFile(second.state.sessionFile, 'utf8')).toContain('Second workspace prompt')
    const heading = page.getByRole('button', { name: 'Research', exact: true })
    await heading.click()
    await expect(heading).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toHaveCount(0)
    await heading.click()
    await page.locator('.workspace').filter({ has: heading }).locator('.session-link').first().click()
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    await expect(page.getByRole('progressbar', { name: 'Context used' })).toBeVisible()
  } catch (error) {
    if (app) console.error(await (await app.firstWindow()).locator('body').innerText())
    throw error
  } finally {
    if (app) {
      await app
        .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
        .catch(() => {})
      await app.close().catch(() => {})
    }
    await fixture.dispose()
  }
})
