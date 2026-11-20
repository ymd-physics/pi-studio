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
    // Check the actual glyph sources, not just CSS family names (which can silently fall back).
    const checkPreview = async (postScriptName) => {
      await page.evaluate(() => document.fonts.ready.then(() => true))
      const cdp = await page.context().newCDPSession(page)
      try {
        await cdp.send('DOM.enable'); await cdp.send('CSS.enable')
        const { root } = await cdp.send('DOM.getDocument')
        for (const lang of ['en', 'zh-CN']) {
          const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `.pp-font-preview [lang="${lang}"]` })
          const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
          expect(fonts.filter(f => f.glyphCount > 0).map(f => [f.postScriptName, f.isCustomFont])).toEqual([[postScriptName, true]])
        }
      } finally { await cdp.detach() }
    }
    const original = await fonts()
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByRole('button', { name: /^Font/ }).click()
    await expect(page.getByRole('button', { name: 'Default', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByLabel('Font preview')).toContainText('给想法留一点空间。')
    await page.getByRole('button', { name: 'Serif', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-font', 'serif')
    await checkPreview('SourceHanSerifCN-Regular')
    const selected = await fonts()
    expect(selected.prose).toContain('Studio Serif')
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
    await page.getByRole('button', { name: 'Literary', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-font', 'literary')
    const literary = await fonts()
    await checkPreview('StudioLiterary-Regular')
    expect(literary.prose.split(',')[0]).toContain('Studio Literary')
    for (const key of ['code', 'math', 'ui', 'toolbar']) expect(literary[key]).toBe(original[key])
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
