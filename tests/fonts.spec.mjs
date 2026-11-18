import { test, expect, _electron as electron } from '@playwright/test'
import { createFixture } from './fixture.mjs'

test('font preset previews immediately, preserves code/math/UI fonts, and survives restart', async () => {
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
    await expect(page.locator('.assistant-message .prose').first()).toBeVisible()
    const fonts = () =>
      page.evaluate(() => {
        const font = (selector) => getComputedStyle(document.querySelector(selector)).fontFamily
        return {
          prose: font('.assistant-message .prose'),
          code: font('.code-block pre'),
          math: font('.katex'),
          ui: font('.sidebar'),
          toolbar: font('.code-toolbar'),
        }
      })
    const original = await fonts()
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByRole('button', { name: /^Font/ }).click()
    await expect(page.getByRole('button', { name: 'Default', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByLabel('Font preview')).toContainText('给想法留一点空间。')
    await page.getByRole('button', { name: 'Serif', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-font', 'serif')
    expect(await page.getByLabel('Font preview').evaluate((el) => getComputedStyle(el).fontFamily)).toContain(
      'Iowan Old Style',
    )
    const selected = await fonts()
    expect(selected.prose).toContain('Iowan Old Style')
    expect(selected.prose).not.toBe(original.prose)
    for (const key of ['code', 'math', 'ui', 'toolbar']) expect(selected[key]).toBe(original[key])
    await page.screenshot({ path: 'test-results/font-preferences.png' })
    await page.getByRole('button', { name: 'Close preferences' }).click()
    await page.screenshot({ path: 'test-results/font-serif.png' })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await expect(page.locator('html')).toHaveAttribute('data-font', 'serif')
    await expect(page.locator('.assistant-message .prose').first()).toBeVisible()
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByRole('button', { name: /^Font/ }).click()
    await expect(page.getByRole('button', { name: 'Serif', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Back to Appearance' }).click()
    await page.getByRole('button', { name: /^Theme/ }).click()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    expect((await fonts()).prose).toBe(selected.prose)
    await page.getByRole('button', { name: 'Back to Appearance' }).click()
    await page.getByRole('button', { name: /^Font/ }).click()
    await page.getByRole('button', { name: 'Default', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-font', 'default')
    expect(await fonts()).toEqual(original)
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
