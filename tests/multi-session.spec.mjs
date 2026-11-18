import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('independent sessions keep working across workspaces, scope dialogs, close idle writers and resize panels', async () => {
  const fixture = await createFixture()
  let app
  try {
    app = await electron.launch({
      args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
      executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
      env: fixture.env,
    })
    const page = await app.firstWindow()
    const input = page.getByRole('textbox', { name: 'Message Pi' })
    await expect(input).toBeVisible()
    const a = await page.evaluate(() => window.desktop.snapshot())
    const aRow = page.locator('.session-link').filter({ hasText: 'Discuss the harmonic oscillator' })
    await input.fill('Please slow tool A')
    await input.press('Enter')
    await expect(aRow).toHaveAttribute('data-status', 'working')
    await page.getByRole('button', { name: 'New session in Research' }).click()
    await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click()
    await expect(page.locator('.session-view:visible .empty-state')).toBeVisible()
    await input.fill('Please slow tool B')
    await input.press('Enter')
    await expect(page.locator('.session-link[data-status="working"]')).toHaveCount(2)
    const b = await page.evaluate(() => window.desktop.snapshot())
    expect(a.handle).not.toBe(b.handle)
    await aRow.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Close session' })).toBeDisabled()
    await expect(page.getByRole('menuitem', { name: 'Delete session…' })).toBeEnabled()
    await page.keyboard.press('Escape')
    expect(
      await page.evaluate(async (h) => {
        try {
          await window.desktop.closeSession(h)
          return 'unsafe'
        } catch {
          return 'protected'
        }
      }, a.handle),
    ).toBe('protected')
    await aRow.click()
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).handle)
      .toBe(a.handle)
    await expect(page.locator(`.session-view[data-session-handle="${a.handle}"]`)).toBeVisible()
    await page.getByRole('button', { name: 'Stop generation' }).click()
    await expect(aRow).toHaveAttribute('data-status', 'active')
    expect(
      (await page.evaluate(() => window.desktop.runningSessions())).find((s) => s.handle === b.handle).status,
    ).toBe('working')
    await input.fill(`/desktop-switch ${b.state.sessionFile}`)
    await input.press('Enter')
    await expect(page.getByText('Open sessions from the Pi Studio sidebar.', { exact: false })).toBeVisible()
    expect((await page.evaluate((h) => window.desktop.snapshot(h), a.handle)).state.sessionFile).toBe(
      a.state.sessionFile,
    )
    expect((await page.evaluate((h) => window.desktop.snapshot(h), b.handle)).state.sessionFile).toBe(
      b.state.sessionFile,
    )
    await input.fill('Draft stays with A')

    const other = join(fixture.root, 'second-workspace')
    await mkdir(other)
    await writeFile(join(other, 'notes.md'), 'Other workspace')
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    }, other)
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await page.getByRole('button', { name: 'New session in second-workspace' }).click()
    await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click()
    await expect(page.locator('.session-view:visible .breadcrumbs')).toContainText('second-workspace')
    const c = await page.evaluate(() => window.desktop.snapshot())
    await input.fill('Independent workspace C')
    await input.press('Enter')
    await expect(
      page
        .locator('.session-view:visible')
        .getByText('The native Pi session is connected.', { exact: false }),
    ).toBeVisible()
    expect(
      (await page.evaluate(() => window.desktop.runningSessions())).find((s) => s.handle === b.handle).status,
    ).toBe('working')
    // Start an extension request in background A; its dialog must not hijack workspace C.
    await page.evaluate((h) => {
      window.backgroundPermission = window.desktop.command('prompt', { message: '/desktop-check' }, h)
    }, a.handle)
    await expect(aRow.getByLabel('Waiting for your response')).toBeVisible()
    await expect(aRow).toHaveAttribute('data-status', 'waiting')
    await expect(aRow.locator('.session-status .spin')).toHaveCount(0)
    await expect(aRow).toHaveAttribute('title', /1 pending request/)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'Research', exact: true }).click()
    await expect(page.getByLabel('1 session waiting for your response')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.screenshot({ path: 'test-results/waiting-workspace.png' })
    await page.getByRole('button', { name: 'Research', exact: true }).click()
    await aRow.click()
    await expect(page.getByRole('dialog', { name: 'Choose a test option' })).toBeVisible()
    await page.screenshot({ path: 'test-results/multi-session-permission-light.png' })
    await page.getByRole('radio', { name: 'Beta', exact: true }).check()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(input).toHaveValue('Extension replied')
    await expect(aRow).toHaveAttribute('data-status', 'active')
    await page.evaluate(() => window.backgroundPermission)
    expect(
      (await page.evaluate((h) => window.desktop.snapshot(h), c.handle)).messages.some((m) =>
        JSON.stringify(m.content).includes('Independent workspace C'),
      ),
    ).toBe(true)
    await input.fill('Retained draft A')
    await page.locator('.session-link').filter({ hasText: 'Please slow tool B' }).click()
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).handle)
      .toBe(b.handle)
    await page.getByRole('button', { name: 'Stop generation' }).click()
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0)
    await aRow.click()
    await expect(input).toHaveValue('Retained draft A')
    await aRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close session' }).click()
    await expect(aRow).toHaveAttribute('data-status', 'inactive')
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toHaveCount(0)
    expect(await readFile(a.state.sessionFile, 'utf8')).toContain('Please slow tool A')
    await aRow.click()
    await expect(input).toBeVisible()
    await expect(aRow).toHaveAttribute('data-status', 'active')
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessionFile).toBe(a.state.sessionFile)
    const left = page.getByRole('separator', { name: 'Resize workspace sidebar' })
    const before = Number(await left.getAttribute('aria-valuenow'))
    const edge = await left.boundingBox()
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 180)
    await page.mouse.down()
    await page.mouse.move(edge.x + 100, edge.y + 180)
    await page.mouse.up()
    await expect
      .poll(async () => Number(await left.getAttribute('aria-valuenow')))
      .toBeGreaterThan(before + 80)
    await left.focus()
    await left.press('Home')
    expect(Number(await left.getAttribute('aria-valuenow'))).toBe(before)
    await page.getByRole('button', { name: 'Toggle files' }).click()
    const right = page.getByRole('separator', { name: 'Resize file panel' })
    await right.focus()
    const rightBefore = Number(await right.getAttribute('aria-valuenow'))
    await right.press('ArrowLeft')
    expect(Number(await right.getAttribute('aria-valuenow'))).toBe(rightBefore + 20)
    await page.screenshot({ path: 'test-results/multi-session-panels.png' })
    await right.press('Home')
    await page.getByRole('button', { name: 'Close files' }).click()
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByRole('button', { name: /^Theme/ }).click()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await page.getByRole('button', { name: 'Close preferences' }).click()
    await input.fill('/desktop-check')
    await input.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.screenshot({ path: 'test-results/multi-session-permission-dark.png' })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(aRow).toHaveAttribute('data-status', 'active')
    await left.focus()
    await left.press('ArrowRight')
    const rememberedWidth = await left.getAttribute('aria-valuenow')
    await app.close()
    app = await electron.launch({
      args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
      executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
      env: fixture.env,
    })
    const restarted = await app.firstWindow()
    await expect(restarted.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    await expect(restarted.getByRole('separator', { name: 'Resize workspace sidebar' })).toHaveAttribute(
      'aria-valuenow',
      rememberedWidth,
    )
    await expect(restarted.locator('.session-link[data-status="active"]')).toHaveCount(1)
    await expect(restarted.locator('.session-link[data-status="inactive"]')).toHaveCount(2)
    await expect(restarted.locator('.session-link[data-status="working"]')).toHaveCount(0)
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
