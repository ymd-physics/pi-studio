import { test, expect, _electron as electron } from '@playwright/test'
import { createFixture } from './fixture.mjs'

test('tables center as a whole, retain cell alignment and scroll inside narrow conversations', async () => {
  const fixture = await createFixture()
  let app
  try {
    app = await electron.launch({
      args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
      executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
      env: fixture.env,
    })
    const page = await app.firstWindow()
    await expect(page.locator('.table-scroll table')).toBeVisible()
    const centered = async (locator) =>
      locator.evaluate((table) => {
        const bounds = table.getBoundingClientRect(),
          parent = table.parentElement.getBoundingClientRect()
        return Math.abs(bounds.x + bounds.width / 2 - parent.x - parent.width / 2)
      })
    expect(await centered(page.locator('.table-scroll table'))).toBeLessThan(2)
    const handle = await page.evaluate(async () => (await window.desktop.snapshot()).handle)
    const wide = `| ${Array.from({ length: 20 }, (_, n) => 'Column' + n).join(' | ')} |\n| ${Array(20).fill('---').join(' | ')} |\n| ${Array(20).fill('123456789').join(' | ')} |`
    const text = '| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |\n\n' + wide
    // Presentation-only events in an isolated app; do not write fake native history.
    await app.evaluate(
      ({ BrowserWindow }, { handle, text }) => {
        const message = { role: 'assistant', timestamp: Date.now(), content: [{ type: 'text', text }] }
        for (const type of ['message_start', 'message_end'])
          BrowserWindow.getAllWindows()[0].webContents.send('pi:event', {
            type,
            desktopSession: handle,
            message,
          })
      },
      { handle, text },
    )
    const tables = page.locator('.table-scroll table')
    await expect(tables).toHaveCount(3)
    expect(await centered(tables.nth(1))).toBeLessThan(2)
    expect(
      await tables
        .nth(1)
        .locator('td')
        .evaluateAll((cells) => cells.map((cell) => getComputedStyle(cell).textAlign)),
    ).toEqual(['left', 'center', 'right'])
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 640))
    const wideRegion = page.getByRole('region', { name: 'Table', exact: true }).last()
    await wideRegion.scrollIntoViewIfNeeded()
    expect(await wideRegion.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
    // Wide tables must scroll, not squeeze each word into a vertical stack.
    expect((await tables.last().boundingBox()).height).toBeLessThan(140)
    await wideRegion.focus()
    await wideRegion.press('ArrowRight')
    await expect.poll(() => wideRegion.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: 'test-results/tables-centered-narrow.png' })
  } finally {
    if (app) {
      await app
        .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.destroy()))
        .catch(() => {})
      await app.close().catch(() => {})
    }
    await fixture.dispose()
  }
})
