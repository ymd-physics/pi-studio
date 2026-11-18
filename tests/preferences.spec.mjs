import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('category preferences and workspace plugin inventories are scoped, read-only and accessible', async () => {
  const fixture = await createFixture()
  let app
  try {
    await writeFile(join(fixture.agentDir, 'extensions/global-preview.ts'), 'export default function () {}')
    await mkdir(join(fixture.workspace, '.pi/extensions'), { recursive: true })
    await writeFile(join(fixture.workspace, '.pi/extensions/local-preview.ts'), 'export default function () {}')
    app = await electron.launch({ args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'], executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE, env: fixture.env })
    const page = await app.firstWindow()
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
    await expect(page.locator('.brand-name')).toHaveText('Pi Studio')
    await expect(page.getByLabel('Pi Studio version', { exact: true })).toHaveText(`v${version}`)
    expect(await app.evaluate(({ app }) => app.getVersion())).toBe(version)
    expect(await app.evaluate(({ app }) => app.getName())).toBe('Pi Studio')
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(fixture.env.PI_DESKTOP_DATA_DIR)
    const checkBrand = async () => {
      const style = await page.locator('.brand').evaluate(el => {
        const mark = getComputedStyle(el.querySelector('.pi-mark'))
        const version = getComputedStyle(el.querySelector('.brand-version'))
        const name = el.querySelector('.brand-name').getBoundingClientRect()
        const label = el.querySelector('.brand-version').getBoundingClientRect()
        return { font: mark.fontFamily, size: mark.fontSize, weight: mark.fontWeight, line: mark.lineHeight, gap: getComputedStyle(el).gap, height: el.getBoundingClientRect().height, textTransform: getComputedStyle(el.querySelector('.brand-identity')).transform, versionGap: Math.round(label.top - name.bottom), border: version.borderTopWidth, background: version.backgroundColor, aligned: Math.abs(name.left - label.left) < 1, below: label.top >= name.bottom, overflow: el.scrollWidth > el.clientWidth }
      })
      expect(style).toEqual({ font: 'Georgia, serif', size: '54px', weight: '400', line: '42px', gap: '14px', height: 79, textTransform: 'matrix(1, 0, 0, 1, 0, 3)', versionGap: 4, border: '0px', background: 'rgba(0, 0, 0, 0)', aligned: true, below: true, overflow: false })
    }
    await checkBrand()
    await page.locator('.brand').screenshot({ path: 'test-results/brand-quiet-light.png' })
    const before = await page.evaluate(() => window.desktop.runningSessions())
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    const preferences = page.getByRole('dialog', { name: 'Preferences', exact: true })
    await expect(preferences).toBeVisible()
    await expect(preferences.getByRole('navigation').getByRole('button')).toHaveText(['Appearance', 'Plugins', 'About'])
    await expect(preferences.locator('.pp-group .pp-row strong')).toHaveText(['Language', 'Theme', 'Font'])
    const language = preferences.locator('.pp-group').getByRole('button', { name: /^Language/ })
    await expect(language).toContainText('English')
    await language.click()
    // CSS font-size alone cannot detect locale-dependent macOS glyph fallback.
    const textMetrics = () => page.locator('.sidebar').evaluate(sidebar => {
      const probe = document.createElement('span')
      probe.style.cssText = 'position:absolute;white-space:pre;visibility:hidden'
      probe.textContent = 'Pi Studio 123 中文工作区'
      sidebar.append(probe)
      const { width, height } = probe.getBoundingClientRect()
      const size = getComputedStyle(probe).fontSize
      probe.remove()
      return { width, height, size }
    })
    const originalMetrics = await textMetrics()
    await expect(preferences.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true')
    await preferences.getByRole('button', { name: '简体中文' }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    expect(await textMetrics()).toEqual(originalMetrics)
    const zhPreferences = page.getByRole('dialog', { name: '偏好设置' })
    await zhPreferences.getByRole('button', { name: '关于' }).click()
    const projectUrl = 'https://github.com/ymd-physics/pi-studio'
    await expect(zhPreferences.locator('.pp-about-credit dt')).toHaveText(['作者：', '项目地址：', '说明：'])
    await expect(zhPreferences.locator('.pp-about-credit dd')).toHaveText(['YM', projectUrl, 'OpenAI 的 GPT 模型辅助开发。由 Pi 驱动。'])
    await expect(zhPreferences.getByRole('link', { name: projectUrl })).toHaveAttribute('href', projectUrl)
    await page.getByRole('button', { name: '关闭偏好设置' }).click()
    await expect(page.getByRole('textbox', { name: '给 Pi 发消息' })).toBeVisible()
    await expect(page.getByRole('button', { name: '移除工作区“Research”' })).toHaveAttribute('title', '移除工作区“Research”')
    await page.reload()
    await page.getByRole('button', { name: '偏好设置', exact: true }).click()
    const retained = page.getByRole('button', { name: /^语言/ })
    await expect(retained).toContainText('简体中文')
    await retained.click()
    await expect(page.getByRole('button', { name: '简体中文' })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'English' }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    expect(await textMetrics()).toEqual(originalMetrics)
    await preferences.getByRole('button', { name: 'Plugins', exact: true }).click()
    await expect(preferences).toContainText('global-preview.ts')
    await expect(preferences).not.toContainText('local-preview.ts')
    await expect(preferences.getByText('Studio adapted', { exact: true })).toHaveCount(4)
    await expect(preferences.getByText('Recommended', { exact: true })).toHaveCount(4)
    await expect(preferences).toContainText('Recommended: ≥ 0.47.0')
    await preferences.locator('.pp-plugin').filter({ hasText: 'npm:pi-subagents' }).getByText('Installation instructions').click()
    await expect(preferences).toContainText('pi install npm:pi-subagents')
    await page.screenshot({ path: 'test-results/preferences-plugins.png' })
    // Modal focus stays inside; background composer must not receive keystrokes.
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); expect(await preferences.evaluate(el => el.contains(document.activeElement))).toBe(true) }
    await preferences.getByRole('button', { name: 'About', exact: true }).click()
    await expect(preferences).toContainText('Pi Studio')
    await expect(preferences.locator('.pp-about-credit dt')).toHaveText(['Author:', 'Repository:', 'Credits:'])
    await expect(preferences.locator('.pp-about-credit dd')).toHaveText(['YM', projectUrl, 'Built with assistance from OpenAI’s GPT models. Powered by Pi.'])
    await expect(preferences.getByRole('link', { name: projectUrl })).toHaveAttribute('href', projectUrl)
    await expect(preferences).toContainText('Recommended: Pi ≥ 1.4.0')
    await page.screenshot({ path: 'test-results/studio-about.png' })
    await expect(preferences).toContainText('pi-coding-agent')
    await expect(preferences).toContainText(version)
    await page.keyboard.press('Escape')
    await expect(preferences).toHaveCount(0)
    await page.getByRole('button', { name: 'Workspace information for Research' }).click()
    const workspace = page.getByRole('dialog', { name: 'Workspace information' })
    await expect(workspace).toContainText('local-preview.ts')
    await expect(workspace).not.toContainText('global-preview.ts')
    await workspace.getByRole('button', { name: /^Global/ }).click()
    await expect(workspace).toContainText('global-preview.ts')
    await expect(workspace).not.toContainText('local-preview.ts')
    await page.screenshot({ path: 'test-results/workspace-information.png' })
    await expect(page.evaluate(() => window.desktop.plugins('/untrusted'))).rejects.toThrow()
    expect(await page.evaluate(() => window.desktop.runningSessions())).toEqual(before)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByRole('button', { name: /^Theme/ }).click()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await checkBrand()
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(680, 660))
    await page.screenshot({ path: 'test-results/preferences-narrow-dark.png' })
    expect(await page.evaluate(() => { const d = document.querySelector('dialog').getBoundingClientRect(); return d.left >= 0 && d.top >= 0 && d.right <= innerWidth && d.bottom <= innerHeight })).toBe(true)
    await page.keyboard.press('Escape')
    await checkBrand()
    await page.locator('.brand').screenshot({ path: 'test-results/brand-quiet-dark.png' })
  } finally {
    if (app) { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {}); await app.close().catch(() => {}) }
    await fixture.dispose()
  }
})
