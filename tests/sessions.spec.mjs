import { test, expect, _electron as electron } from '@playwright/test'
import { readFile, stat } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

test('sessions resume in place; clone and recoverable deletion are explicit', async () => {
  const fixture = await createFixture()
  const launch = () =>
    electron.launch({
      args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
      executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
      env: fixture.env,
    })
  let app
  try {
    app = await launch()
    let page = await app.firstWindow()
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    const original = await page.evaluate(() => window.desktop.snapshot())
    const source = await readFile(original.state.sessionFile, 'utf8')
    await page.locator('.session-link.selected').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Clone session', exact: true }).click()
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.sessionFile)
      .not.toBe(original.state.sessionFile)
    const clone = await page.evaluate(() => window.desktop.snapshot())
    expect(clone.messages).toEqual(original.messages)
    expect(await readFile(original.state.sessionFile, 'utf8')).toBe(source)
    expect(await page.evaluate((w) => window.desktop.sessions(w), fixture.workspace)).toHaveLength(2)
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    await page.locator('.session-link.selected').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete session…' }).click()
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeEnabled()
    expect((await page.evaluate(() => window.desktop.command('get_state'))).sessionFile).toBe(
      clone.state.sessionFile,
    )
    await app.evaluate(({ dialog, shell }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      // Test the recoverable operation without putting test data in the user's Trash.
      shell.trashItem = async (path) => {
        const fs = process.getBuiltinModule('node:fs/promises')
        await fs.rename(path, path + '.trashed')
      }
    })
    await page.locator('.session-link.selected').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete session…' }).click()
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toHaveCount(0)
    await expect
      .poll(async () =>
        stat(clone.state.sessionFile).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false)
    expect(await readFile(clone.state.sessionFile + '.trashed', 'utf8')).toContain(
      'Discuss the harmonic oscillator',
    )
    expect(await readFile(original.state.sessionFile, 'utf8')).toBe(source)
    expect(await page.evaluate((w) => window.desktop.sessions(w), fixture.workspace)).toHaveLength(1)
    await page.getByRole('button', { name: 'New session in Research' }).click()
    await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click()
    await page.getByRole('textbox', { name: 'Message Pi' }).fill('Desktop-created conversation')
    await page.getByRole('textbox', { name: 'Message Pi' }).press('Enter')
    await expect(page.getByText('The native Pi session is connected.', { exact: false })).toBeVisible()
    const desktop = await page.evaluate(() => window.desktop.snapshot())
    await page.locator('.session-link').filter({ hasText: 'Discuss the harmonic oscillator' }).click()
    await expect(page.locator('.session-view:visible').getByLabel('Model', { exact: true })).toBeEnabled()
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.sessionFile)
      .toBe(original.state.sessionFile)
    await page.locator('.session-link').filter({ hasText: 'Desktop-created conversation' }).click()
    await expect(page.locator('.session-view:visible').getByLabel('Model', { exact: true })).toBeEnabled()
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.sessionFile)
      .toBe(desktop.state.sessionFile)
    expect(await page.evaluate((w) => window.desktop.sessions(w), fixture.workspace)).toHaveLength(2)
    await app.close()
    app = undefined
    app = await launch()
    page = await app.firstWindow()
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessionFile).toBe(
      desktop.state.sessionFile,
    )
    expect(await page.evaluate((w) => window.desktop.sessions(w), fixture.workspace)).toHaveLength(2)
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
