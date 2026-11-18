import { test, expect, _electron as electron } from '@playwright/test'
import { createFixture } from './fixture.mjs'

test('display math copies TeX; native tools use two levels and observed clocks settle once', async () => {
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
    // Exercise the real macOS clipboard; a renderer mock previously hid permission failures.
    // Keep the user's common clipboard formats in main-process memory and restore on exit.
    await app.evaluate(({ clipboard }) => {
      globalThis.__previousClipboard = {
        text: clipboard.readText(),
        html: clipboard.readHTML(),
        rtf: clipboard.readRTF(),
        image: clipboard.readImage(),
      }
      clipboard.clear()
    })
    await page.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      'import numpy as np\nenergy = hbar * omega * (n + 0.5)\n',
    )
    await page.getByRole('button', { name: 'Copy LaTeX' }).click()
    await expect(page.getByRole('button', { name: 'LaTeX copied' })).toBeVisible()
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      String.raw`\int_0^\infty e^{-x^2}\,dx=\frac{\sqrt{\pi}}2`,
    )
    const response = await page.evaluate(() => window.desktop.command('get_last_assistant_text'))
    await input.fill('/copy')
    await input.press('Enter')
    await expect(page.getByText('Response copied.', { exact: true })).toBeVisible()
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(response.text)
    for (const invalid of [null, 'x'.repeat(16 * 1024 * 1024 + 1)]) {
      const error = await page.evaluate(async (value) => {
        try {
          await window.desktop.copyText(value)
          return ''
        } catch (error) {
          return String(error)
        }
      }, invalid)
      expect(error).toContain('Clipboard text must be a string no larger than 16 MiB')
    }
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(response.text)
    // Restored history must not show invented elapsed times or throughput.
    await expect(page.getByLabel('Response statistics')).toHaveCount(0)
    await input.fill('Please grouped tools')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: /Thinking…/ })).toBeVisible()
    await expect(page.locator('.working[role="status"]')).toContainText(/Working… \d+s/)
    const group = page.getByRole('region', { name: '3 tool calls' })
    await expect(group).toBeVisible()
    await expect(group.getByRole('button', { name: /bash.*running/ }).first()).toBeVisible()
    const title = group.getByRole('button', { name: '3 tool calls', exact: true })
    await expect(title).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByLabel('Model', { exact: true })).toBeEnabled()
    await expect(group.getByText('1 failed', { exact: true })).toBeVisible()
    await expect(group.getByRole('button', { name: /bash.*exit 2/ })).toHaveCount(0)
    await title.click()
    await expect(group.getByRole('button', { name: /bash.*exit 2/ })).toBeVisible()
    await expect(group.locator('.tool-output')).toHaveCount(0)
    await group.getByRole('button', { name: /bash.*exit 2/ }).click()
    await expect(group.locator('.tool-output')).toContainText('code 2')
    await title.click()
    await expect(group.locator('.tool-output')).toHaveCount(0)
    await title.click()
    await expect(group.locator('.tool-output')).toContainText('code 2')
    const stats = page.getByLabel('Response statistics')
    await expect(stats).toHaveCount(1)
    await expect(stats).toContainText(/\d+\.\d tok\/s/)
    await expect(stats).toContainText('in 200')
    await expect(stats).toContainText('out 40')
    await expect(page.getByRole('button', { name: /Thought \d+s/ }).first()).toBeVisible()
    await expect(page.locator('.working[role="status"]')).toHaveCount(0)
    const titleBox = await title.boundingBox()
    const tagsBox = await group.getByLabel('Tool breakdown').boundingBox()
    expect(tagsBox.y).toBeGreaterThan(titleBox.y + titleBox.height)
    await group.locator('.tool-group-summary').screenshot({ path: 'test-results/tool-summary-light.png' })
    await page.screenshot({ path: 'test-results/presentation-light.png' })
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await group.locator('.tool-group-summary').screenshot({ path: 'test-results/tool-summary-dark.png' })
    await page.screenshot({ path: 'test-results/presentation-dark.png' })
    await page.setViewportSize({ width: 720, height: 800 })
    await page.screenshot({ path: 'test-results/presentation-narrow.png' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } catch (error) {
    if (app) console.error(await (await app.firstWindow()).locator('body').innerText())
    throw error
  } finally {
    if (app) {
      await app
        .evaluate(({ clipboard }) => {
          if (globalThis.__previousClipboard) {
            clipboard.write(globalThis.__previousClipboard)
            delete globalThis.__previousClipboard
          }
        })
        .catch(() => {})
      await app
        .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
        .catch(() => {})
      await app.close().catch(() => {})
    }
    await fixture.dispose()
  }
})
