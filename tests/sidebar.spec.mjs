import { test, expect, _electron as electron } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('Workspaces heading replaces the global sidebar action while scoped creation and shortcuts remain', async () => {
  const fixture = await createFixture()
  let app
  try {
    const preferencesPath = join(fixture.dataDir, 'preferences.json')
    const preferences = JSON.parse(await readFile(preferencesPath, 'utf8'))
    delete preferences.activeWorkspace
    delete preferences.activeSession
    await writeFile(preferencesPath, JSON.stringify(preferences))
    const requestsBefore = fixture.requests.length
    app = await electron.launch({
      args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
      executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
      env: fixture.env,
    })
    const page = await app.firstWindow()
    const sidebar = page.locator('.sidebar')
    await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible()
    await expect(sidebar.getByRole('button', { name: /^New conversation/ })).toHaveCount(0)
    await expect(sidebar.getByRole('heading', { name: 'Workspaces', level: 2 })).toBeVisible()
    const create = page.getByRole('button', { name: 'New session in Research', exact: true })
    await expect(create).toBeVisible()
    for (const dark of [false, true]) {
      await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), dark)
      for (const width of [1280, 680]) {
        await page.setViewportSize({ width, height: 820 })
        const geometry = await sidebar.evaluate((element) => {
          const label = element.querySelector('.sidebar-label')
          const title = getComputedStyle(label.querySelector('h2'))
          const brand = element.querySelector('.brand').getBoundingClientRect()
          const add = label.querySelector('button').getBoundingClientRect()
          const bounds = element.getBoundingClientRect()
          // The existing resize hit target deliberately extends 3px outside the sidebar.
          const content = [...element.children].filter((child) => !child.matches('.resize-edge'))
          return {
            font: title.fontSize, weight: title.fontWeight,
            colorMatchesText: title.color === getComputedStyle(document.documentElement).color,
            rule: getComputedStyle(label).borderBottomWidth,
            gap: label.getBoundingClientRect().top - brand.bottom,
            mark: getComputedStyle(element.querySelector('.pi-mark')).fontSize,
            brandHeight: brand.height,
            addWidth: add.width, addHeight: add.height,
            overflow: content.some((child) => {
              const box = child.getBoundingClientRect()
              return box.left < bounds.left - .5 || box.right > bounds.right + .5 || child.scrollWidth > child.clientWidth + 1
            }),
          }
        })
        expect(geometry).toEqual({ font: '13px', weight: '600', colorMatchesText: true, rule: '1px', gap: 8, mark: '54px', brandHeight: 79, addWidth: 24, addHeight: 24, overflow: false })
        expect(await create.evaluate((button) => getComputedStyle(button).opacity)).toBe('1')
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await sidebar.screenshot({ path: `test-results/sidebar-header-${dark ? 'dark' : 'light'}-${width}.png` })
      }
    }
    // Cmd+N works even before any session is opened; no provider call is needed.
    await page.keyboard.press('Meta+n')
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    const first = await page.evaluate(() => window.desktop.snapshot())
    expect(first.workspace).toBe(fixture.workspace)
    await expect(create).toBeEnabled()
    const collapse = page.getByRole('button', { name: 'Research', exact: true })
    await collapse.click()
    await expect(collapse).toHaveAttribute('aria-expanded', 'false')
    await expect(create).toBeVisible()
    await create.click()
    await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).handle).not.toBe(first.handle)
    await expect(create).toBeEnabled()
    const second = await page.evaluate(() => window.desktop.snapshot())
    await page.keyboard.press('Control+n')
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).handle).not.toBe(second.handle)
    expect(fixture.requests).toHaveLength(requestsBefore)
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(await app.evaluate(({ app }) => app.getVersion())).toBe(version)
    await expect(page.getByLabel('Pi Studio version')).toHaveText(`v${version}`)
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.destroy())).catch(() => {})
      await app.close().catch(() => {})
    }
    await fixture.dispose()
  }
})
