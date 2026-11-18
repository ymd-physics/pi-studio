import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('discovers all commands, trusts project extensions, passes arguments and input hooks, reloads in place', async () => {
  const fixture = await createFixture()
  let app
  try {
    await mkdir(join(fixture.workspace, '.pi/extensions'), { recursive: true })
    await writeFile(
      join(fixture.workspace, '.pi/extensions/commands.ts'),
      `export default function(pi) {
      for (let i = 0; i < 20; i++) pi.registerCommand('extra-' + i, { description: 'Extra command', handler: async () => {} });
      pi.registerCommand('perm', {
        description: 'Permission profile: default | workspace',
        getArgumentCompletions: prefix => ['default', 'workspace'].filter(x => x.startsWith(prefix)).map(value => ({value, label:value})),
        handler: async (args, ctx) => { ctx.ui.notify('Permission args: ' + args + '; trusted: ' + ctx.isProjectTrusted(), 'info'); }
      });
      pi.on('input', async (event, ctx) => { if(event.text.startsWith('/hook-only ')) { ctx.ui.notify('Hook received: ' + event.text, 'info'); return {action:'handled'}; } });
    }`,
    )
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
    await input.fill('/')
    const list = page.getByRole('listbox', { name: 'Slash commands' })
    await expect(list.getByRole('option')).toHaveCount(initial.commands.length + 12)
    await list.getByRole('option').filter({ hasText: '/perm' }).click()
    await expect(input).toHaveValue('/perm ')
    await input.fill('/perm workspace')
    await expect(page.getByRole('note')).toContainText('Permission profile')
    await input.press('Enter')
    await expect(page.getByText('Permission args: workspace; trusted: true', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Model', { exact: true })).toBeEnabled()
    await input.fill('/hook-only untouched arguments')
    await input.press('Enter')
    await expect(
      page.getByText('Hook received: /hook-only untouched arguments', { exact: true }),
    ).toBeVisible()
    await expect(page.getByLabel('Model', { exact: true })).toBeEnabled()
    await input.fill('/model')
    await input.press('Enter')
    await expect(page.getByText('Use the model selector in the composer.', { exact: true })).toBeVisible()
    expect(fixture.requests).toHaveLength(before)
    await writeFile(
      join(fixture.agentDir, 'extensions/newly-installed.ts'),
      `export default function(pi) { pi.registerCommand('newly-installed', { description: 'Fresh resource', handler: async (_, ctx) => ctx.ui.notify('Fresh command executed', 'info') }); }`,
    )
    await input.fill('/reload')
    await input.press('Enter')
    await expect(
      page.getByText('Pi resources reloaded. Session history preserved.', { exact: true }),
    ).toBeVisible()
    const after = await page.evaluate(() => window.desktop.snapshot())
    expect(after.state.sessionFile).toBe(initial.state.sessionFile)
    expect(after.messages).toEqual(initial.messages)
    expect(after.commands.some((c) => c.name === 'newly-installed')).toBe(true)
    expect(await page.evaluate((w) => window.desktop.sessions(w), fixture.workspace)).toHaveLength(1)
    await input.fill('/newly')
    await expect(page.getByRole('option', { name: '/newly-installed Fresh resource' })).toBeVisible()
    await input.press('Tab')
    await input.press('Enter')
    await expect(page.getByText('Fresh command executed', { exact: true })).toBeVisible()
    expect(fixture.requests).toHaveLength(before)
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
