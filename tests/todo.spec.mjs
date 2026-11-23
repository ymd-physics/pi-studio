import { test, expect, _electron as electron } from '@playwright/test'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('reads real rpiv-todo state and restores it per native session', async () => {
  test.skip(
    !process.env.PI_DESKTOP_TEST_TODO,
    'Set PI_DESKTOP_TEST_TODO to the installed rpiv-todo index.ts (read-only)',
  )
  const fixture = await createFixture()
  let app
  try {
    const settings = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'))
    settings.extensions = [process.env.PI_DESKTOP_TEST_TODO]
    settings.defaultTools.push('todo')
    // A compacted session retains its old entries on disk. A full get_entries
    // response for this fixture would exceed the Studio RPC framing limit.
    const { activeSession } = JSON.parse(await readFile(join(fixture.dataDir, 'preferences.json'), 'utf8'))
    const lines = (await readFile(activeSession, 'utf8')).trimEnd().split('\n')
    const leaf = JSON.parse(lines.at(-1))
    await appendFile(activeSession, JSON.stringify({ type: 'custom', customType: 'old-extension-data',
      id: 'feedbeef', parentId: leaf.id, timestamp: new Date().toISOString(), data: 'x'.repeat(33 * 1024 * 1024) }) + '\n')
    await writeFile(join(fixture.agentDir, 'settings.json'), JSON.stringify(settings))
    app = await electron.launch({
      args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
      executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
      env: fixture.env,
    })
    const page = await app.firstWindow()
    const input = page.getByRole('textbox', { name: 'Message Pi' })
    await expect(page.getByRole('button', { name: 'Todo (empty)' })).toBeVisible()
    await input.fill('seed real todo')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: 'Todo (1/2)' })).toBeVisible()
    await page.getByRole('button', { name: 'Todo (1/2)' }).click()
    await expect(page.getByRole('region', { name: 'Session todo' })).toContainText('Check units')
    await expect(page.getByRole('region', { name: 'Session todo' })).toContainText('Depends on #1')
    await page.getByRole('button', { name: 'Close todo' }).click()
    await page.getByRole('button', { name: 'New session in Research' }).click()
    await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Todo (empty)' })).toBeVisible()
    await page.locator('.session-link').filter({ hasText: 'Discuss the harmonic oscillator' }).click()
    await expect(page.getByRole('button', { name: 'Todo (1/2)' })).toBeVisible()
    await input.fill('/reload')
    await input.press('Enter')
    await expect(page.getByText('Pi resources reloaded. Session history preserved.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Todo (1/2)' })).toBeVisible()
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
      await app.close()
    }
    await fixture.dispose()
  }
})
