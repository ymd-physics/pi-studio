import { test, expect, _electron as electron } from '@playwright/test'
import { createFixture } from './fixture.mjs'

test('warm switching reuses writers and scans history only once for the sidebar', async () => {
  const fixture = await createFixture()
  let app
  try {
    await fixture.terminal(['--mode', 'json', '-p', 'Second switching fixture'])
    app = await electron.launch({ args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'], executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE, env: fixture.env })
    const page = await app.firstWindow()
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    await expect(page.locator('.opening-indicator')).toHaveCount(0)
    expect(await page.evaluate(() => window.desktop.runningSessions().then(s => s.length))).toBe(1)
    const row = name => page.locator('.session-link:not(.terminal-link)').filter({ hasText: name })
    await row('Second switching fixture').click()
    await expect(page.locator('.opening-indicator')).toHaveCount(0)
    const before = await page.evaluate(() => window.desktop.runningSessions())
    expect(before).toHaveLength(2)
    // Count actual reads in the disposable main process, not elapsed-time limits.
    // No instrumentation or retained history is added to the application source.
    await app.evaluate(({ ipcMain }, agentDir) => {
      globalThis.switchWork = { reads: 0, lists: 0, opens: 0 }
      const fs = process.getBuiltinModule('fs'), modules = process.getBuiltinModule('module')
      const read = fs.createReadStream
      fs.createReadStream = function (path, ...args) {
        if (String(path).startsWith(agentDir) && String(path).endsWith('.jsonl')) globalThis.switchWork.reads++
        return read.call(this, path, ...args)
      }
      modules.syncBuiltinESMExports()
      const invoke = ipcMain._invokeHandlers.get('pi:invoke')
      ipcMain.removeHandler('pi:invoke')
      ipcMain.handle('pi:invoke', (event, method, args) => {
        if (method === 'sessions') globalThis.switchWork.lists++
        if (method === 'open') globalThis.switchWork.opens++
        return invoke(event, method, args)
      })
    }, fixture.agentDir)
    for (const name of ['Discuss the harmonic oscillator', 'Second switching fixture', 'Discuss the harmonic oscillator', 'Second switching fixture']) {
      // Native pointer focus is not part of this work-count regression.
      await row(name).evaluate(button => button.click())
      await expect(row(name)).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeEnabled()
      await expect(page.locator('.opening-indicator')).toHaveCount(0)
    }
    expect(await app.evaluate(() => globalThis.switchWork)).toEqual({ reads: 8, lists: 4, opens: 4 })
    const after = await page.evaluate(() => window.desktop.runningSessions())
    expect(after.map(s => s.handle).sort()).toEqual(before.map(s => s.handle).sort())
    const selected = await page.locator('.session-view:not([hidden])').getAttribute('data-session-handle')
    expect((await page.evaluate(() => window.desktop.snapshot())).handle).toBe(selected)
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {})
      await app.close().catch(() => {})
    }
    await fixture.dispose()
  }
})
