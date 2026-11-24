import { test, expect, _electron as electron } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const launch = (fixture) =>
  electron.launch({
    args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
    executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
    env: fixture.env,
  })
const pids = async (fixture, name) =>
  (await readFile(join(fixture.workspace, `owned-${name}.pid`), 'utf8')).trim().split(' ').map(Number)
const startTool = async (page, fixture, name) => {
  const input = page.locator('.session-view:visible').getByRole('textbox', { name: 'Message Pi' })
  await input.fill(`owned process ${name}`)
  await input.press('Enter')
  await expect.poll(() => pids(fixture, name).catch(() => [])).toHaveLength(2)
  return pids(fixture, name)
}
test('bounded permission details, timeline notices, confirmed working delete and workspace closure', async () => {
  const fixture = await createFixture()
  let app
  try {
    await writeFile(
      join(fixture.agentDir, 'extensions/long-request.ts'),
      `export default function(pi){pi.registerCommand('long-request',{handler:async(_,ctx)=>{const answer=await ctx.ui.select('W'.repeat(90),['Ｗ'.repeat(80),'Allow '+('long path/'.repeat(500))]);ctx.ui.notify('Long request answered: '+(answer?'chosen':'cancelled'),'info')}})}`,
    )
    app = await launch(fixture)
    const page = await app.firstWindow(),
      input = page.getByRole('textbox', { name: 'Message Pi' })
    await expect(input).toBeVisible()
    await input.fill('/long-request')
    await input.press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const before = await dialog.boundingBox()
    expect(before.height).toBeLessThanOrEqual(521)
    expect(before.width).toBeLessThanOrEqual(771)
    await page.getByRole('button', { name: 'Read full option 1' }).click()
    await expect(page.getByRole('region', { name: 'Full request text' })).toContainText('Ｗ'.repeat(80))
    expect((await dialog.boundingBox()).height).toBe(before.height)
    await page.getByRole('button', { name: 'Close full text' }).click()
    await page.getByRole('button', { name: 'Read full option 2' }).click()
    await expect(page.getByRole('region', { name: 'Full request text' })).toContainText(
      'long path/'.repeat(500),
    )
    expect((await dialog.boundingBox()).height).toBe(before.height)
    await page.screenshot({ path: 'test-results/permission-bounded.png' })
    await page.getByRole('button', { name: 'Close full text' }).click()
    await dialog.getByRole('radio').first().check()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.locator('.session-notice')).toContainText('Long request answered: chosen')
    await expect(page.locator('.session-view .banner')).toHaveCount(0)
    const first = await startTool(page, fixture, 'first')
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 })
    })
    await page.locator('.session-link.selected').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete session…' }).click()
    expect(first.every(alive)).toBe(true)
    await app.evaluate(({ dialog, shell }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
      shell.trashItem = async (path) =>
        process.getBuiltinModule('node:fs/promises').rename(path, path + '.trashed')
    })
    await page.locator('.session-link.selected').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete session…' }).click()
    await expect.poll(() => first.some(alive), { timeout: 15000 }).toBe(false)
    await page.getByRole('button', { name: 'New session in Research' }).click()
    await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click()
    const second = await startTool(page, fixture, 'second')
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 })
    })
    await page.getByRole('button', { name: 'Workspace information for Research' }).click()
    const remove = page.getByRole('dialog', { name: 'Workspace information' }).getByRole('button', { name: 'Remove workspace…' })
    await remove.click()
    await expect(remove).toBeEnabled()
    expect(second.every(alive)).toBe(true)
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await remove.click()
    await expect.poll(() => second.some(alive), { timeout: 15000 }).toBe(false)
    await expect(remove).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Workspace information for Research' })).toHaveCount(0)
  } finally {
    if (app) {
      await app
        .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
        .catch(() => {})
      await app.close()
    }
    await fixture.dispose()
  }
})
test('window close asks once, cancellation preserves work, confirmation exits all Pi/tool PIDs', async () => {
  const fixture = await createFixture()
  let app
  try {
    app = await launch(fixture)
    const page = await app.firstWindow()
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    const first = await startTool(page, fixture, 'first')
    const oldHandle = await page.locator('.session-view:visible').getAttribute('data-session-handle')
    await page.getByRole('button', { name: 'New session in Research' }).click()
    await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click()
    await expect(page.locator('.session-view:visible')).not.toHaveAttribute('data-session-handle', oldHandle)
    await expect(
      page.locator('.session-view:visible').getByRole('textbox', { name: 'Message Pi' }),
    ).toBeEnabled()
    const second = await startTool(page, fixture, 'second')
    await app.evaluate(({ dialog, BrowserWindow }) => {
      globalThis.quitCalls = 0
      dialog.showMessageBox = async () => {
        globalThis.quitCalls++
        return { response: 0 }
      }
      BrowserWindow.getAllWindows()[0].close()
    })
    await expect.poll(() => app.evaluate(() => globalThis.quitCalls)).toBe(1)
    expect([...first, ...second].every(alive)).toBe(true)
    await expect(
      page.locator('.session-view:visible').getByRole('textbox', { name: 'Message Pi' }),
    ).toBeVisible()
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const exited = app.waitForEvent('close', { timeout: 20000 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await exited
    app = undefined
    await expect.poll(() => [...first, ...second].some(alive), { timeout: 10000 }).toBe(false)
  } finally {
    if (app) {
      await app
        .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
        .catch(() => {})
      await app.close()
    }
    await fixture.dispose()
  }
})
