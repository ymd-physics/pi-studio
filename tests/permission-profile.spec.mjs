import { test, expect, _electron as electron } from '@playwright/test'
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

// Optional local integration: copy the supplied extensions into a disposable agent directory.
// Never run the permission command against the user's actual workspace or configuration.
const sourceAgent = process.env.PI_DESKTOP_TEST_PERMISSION_AGENT

test('actual permission-profiles command applies and reloads workspace policy through native RPC', async () => {
  test.skip(
    !sourceAgent,
    'Set PI_DESKTOP_TEST_PERMISSION_AGENT to an agent directory containing permission-profiles and its installed permission-system package',
  )
  const fixture = await createFixture()
  let app
  try {
    await cp(
      join(sourceAgent, 'extensions/permission-profiles'),
      join(fixture.agentDir, 'extensions/permission-profiles'),
      { recursive: true },
    )
    const modules = join(fixture.agentDir, 'npm/node_modules')
    await mkdir(modules, { recursive: true })
    for (const name of ['@gotgenes/pi-permission-system', 'zod', 'tree-sitter-bash', 'web-tree-sitter']) {
      await cp(join(sourceAgent, 'npm/node_modules', name), join(modules, name), {
        recursive: true,
        dereference: true,
      })
    }
    await writeFile(join(fixture.agentDir, 'npm/package.json'), '{"private":true,"type":"module"}')
    const settingsPath = join(fixture.agentDir, 'settings.json')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    settings.extensions = [join(modules, '@gotgenes/pi-permission-system/src/index.ts')]
    await writeFile(settingsPath, JSON.stringify(settings))
    app = await electron.launch({
      args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
      executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
      env: fixture.env,
    })
    const page = await app.firstWindow()
    const input = page.getByRole('textbox', { name: 'Message Pi' })
    await expect(input).toBeVisible()
    const initial = await page.evaluate(() => window.desktop.snapshot())
    expect(initial.commands.some((c) => c.name === 'perm')).toBe(true)
    const before = fixture.requests.length
    await input.fill('/perm workspace')
    await input.press('Enter')
    await expect(page.getByText('已启用 workspace 模式（权限配置已重载）。', { exact: false })).toBeVisible({
      timeout: 20000,
    })
    await expect(page.getByLabel('Model', { exact: true })).toBeEnabled()
    const config = join(fixture.workspace, '.pi/extensions/pi-permission-system/config.json')
    const raw = await readFile(config, 'utf8')
    expect(raw).toContain('// permission-profiles v1 ')
    expect(raw).toContain(fixture.workspace)
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessionFile).toBe(
      initial.state.sessionFile,
    )
    await input.fill('/perm default')
    await input.press('Enter')
    await expect(page.getByText('已恢复 default 模式（权限配置已重载）。', { exact: false })).toBeVisible({
      timeout: 20000,
    })
    expect(
      await stat(config).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect(fixture.requests).toHaveLength(before)
    expect(await page.evaluate((w) => window.desktop.sessions(w), fixture.workspace)).toHaveLength(1)
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
