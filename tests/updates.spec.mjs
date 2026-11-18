import { test, expect, _electron as electron } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('About checks on demand, displays bilingual release notes and saves only the selected DMG', async () => {
  const fixture = await createFixture()
  let app
  try {
    app = await electron.launch({ args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'], executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE, env: fixture.env })
    const page = await app.firstWindow()
    const file = join(fixture.root, 'sample.dmg')
    await app.evaluate(({ net, dialog }, file) => {
      globalThis.updateRequests = []
      let checks = 0, saves = 0
      net.fetch = async url => {
        globalThis.updateRequests.push(url)
        const name = 'Pi-Studio-99.0.0-mac-' + process.arch + '.dmg'
        const assetUrl = 'https://github.com/ymd-physics/pi-studio/releases/download/v99.0.0/' + name
        if (url === assetUrl) return new Response('abc')
        if (url !== 'https://api.github.com/repos/ymd-physics/pi-studio/releases/latest') throw new Error('Unexpected URL')
        if (++checks === 1) return new Response('', { status: 503 })
        return Response.json({ tag_name: checks === 2 ? 'v0.0.1' : 'v99.0.0', prerelease: false, draft: false, body: '## 简体中文\n- 修复会话标题。\n## English\n- Fixed conversation titles.', assets: [{ name, size: 3, state: 'uploaded', browser_download_url: assetUrl, digest: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }] })
      }
      dialog.showSaveDialog = async () => ++saves === 1 ? { canceled: true } : { canceled: false, filePath: file }
    }, file)
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByRole('button', { name: 'About', exact: true }).click()
    expect(await app.evaluate(() => globalThis.updateRequests)).toEqual([])
    const button = name => page.getByRole('button', { name, exact: true })
    await button('Check for Updates').click(); await button('Retry').click()
    await expect(page.getByText('You’re up to date.')).toBeVisible()
    await button('Check for Updates').click(); await expect(page.getByText('Version 99.0.0 is available')).toBeVisible()
    await button('Release Notes').click()
    await expect(page.getByText('修复会话标题。')).toBeVisible(); await expect(page.getByText('Fixed conversation titles.')).toBeVisible()
    await button('Hide Release Notes').click(); expect(await app.evaluate(() => globalThis.updateRequests.length)).toBe(3)
    if (process.platform === 'darwin') {
      await button('Download DMG').click(); await expect(button('Download DMG')).toBeEnabled()
      expect(await app.evaluate(() => globalThis.updateRequests.length)).toBe(3)
      await button('Download DMG').click(); await expect(page.getByText('DMG saved. Open it to install the update.')).toBeVisible()
      expect(await readFile(file, 'utf8')).toBe('abc')
    } else await expect(button('Download DMG')).toHaveCount(0)
  } finally {
    if (app) { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {}); await app.close().catch(() => {}) }
    await fixture.dispose()
  }
})
