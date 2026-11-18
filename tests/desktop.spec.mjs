import { test, expect, _electron as electron } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('real Pi: terminal history, in-place continuation, commands, tools, files and restart', async () => {
  const fixture = await createFixture()
  const launch = () =>
    electron.launch({
      args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
      executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
      env: fixture.env,
    })
  let app
  const errors = []
  try {
    app = await launch()
    let page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(String(error)))
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    await expect(page.getByLabel('Pi Studio version')).toHaveText(`v${version}`)
    expect(await app.evaluate(({ app }) => app.getVersion())).toBe(version)
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    const initial = await page.evaluate(() => window.desktop.snapshot())
    const header = page.locator('.session-view:visible .breadcrumbs strong')
    await expect(header).toHaveText('Untitled conversation')
    await expect(header).toHaveAttribute('title', 'Untitled conversation')
    const source = initial.state.sessionFile
    const original = await readFile(source, 'utf8')
    expect(initial.messages.some((m) => m.role === 'assistant')).toBe(true)
    await expect(page.locator('.katex').first()).toBeVisible()
    await page.screenshot({ path: 'test-results/math-and-code.png' })
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    const active = await page.evaluate(() => window.desktop.snapshot())
    expect(active.state.sessionFile).toBe(source)
    expect(await readFile(source, 'utf8')).toBe(original)
    expect(active.messages).toEqual(initial.messages)
    expect(active.commands.map((c) => c.name)).toEqual(
      expect.arrayContaining(['desktop-check', 'skill:demo', 'explain']),
    )
    await page.getByLabel('Model', { exact: true }).selectOption('desktop-test/second-model')
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.model.id)
      .toBe('second-model')
    await page.getByLabel('Thinking level').selectOption('high')
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.thinkingLevel)
      .toBe('high')
    const input = page.getByRole('textbox', { name: 'Message Pi' })
    await input.fill('/desktop-check')
    await input.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Choose a test option' })).toBeVisible()
    await page.getByRole('radio', { name: 'Beta', exact: true }).check()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.getByText('Selected: Beta', { exact: true })).toBeVisible()
    await expect(input).toHaveValue('Extension replied')
    await expect(page.getByText('Extension ready', { exact: true })).toBeVisible()
    await input.fill('Please run tool')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0)
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.desktop.snapshot())).messages.filter(
            (m) => m.role === 'toolResult',
          ).length,
      )
      .toBe(1)
    await expect(page.getByText('Native tool finished.', { exact: false })).toBeVisible()
    await input.fill('Please slow tool')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop generation' })).toBeVisible()
    await page.getByRole('button', { name: 'Stop generation' }).click()
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0)
    await page.locator('.session-link.selected').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename session', exact: true }).click()
    await page.getByRole('textbox', { name: 'Session name' }).fill('Research conversation')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.locator('.breadcrumbs')).toContainText('Research conversation')
    await page.getByRole('button', { name: 'Toggle files' }).click()
    await page.getByRole('button', { name: 'example.py', exact: true }).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('textbox', { name: 'File editor' }).fill('print("edited")\n')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => readFile(join(fixture.workspace, 'example.py'), 'utf8')).toBe('print("edited")\n')
    await page.getByRole('textbox', { name: 'File editor' }).fill('unsaved draft')
    await writeFile(join(fixture.workspace, 'example.py'), 'external change')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(
      page.getByRole('complementary', { name: 'Workspace files' }).getByRole('alert'),
    ).toContainText('File changed on disk')
    await expect(page.getByRole('textbox', { name: 'File editor' })).toHaveValue('unsaved draft')
    await app.evaluate(({ dialog, BrowserWindow }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
      BrowserWindow.getAllWindows()[0].close()
    })
    // Cancelling quit must keep both the unsaved draft AND the native process alive.
    await expect(page.getByRole('textbox', { name: 'File editor' })).toHaveValue('unsaved draft')
    expect((await page.evaluate(() => window.desktop.command('get_state'))).sessionFile).toBe(
      active.state.sessionFile,
    )
    // Electron's native JS dialogs are not reliably controlled through CDP.
    await page.evaluate(() => {
      window.confirm = () => true
    })
    await page.getByRole('button', { name: 'Close files' }).click()
    await page.screenshot({ path: 'test-results/conversation-light.png' })
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByRole('button', { name: /^Theme/ }).click()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await page.getByRole('button', { name: 'Close preferences' }).click()
    await expect(page.locator('html')).toHaveClass('dark')
    await page.screenshot({ path: 'test-results/conversation-dark.png' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 640))
    await page.screenshot({ path: 'test-results/conversation-narrow.png' })
    const desktopPath = (await page.evaluate(() => window.desktop.snapshot())).state.sessionFile
    // Quit now always confirms, including after the unsaved editor was closed.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    await app.close()
    app = undefined
    expect(desktopPath).toBe(source)
    expect(await readFile(source, 'utf8')).not.toBe(original)
    const resumed = await fixture.terminal([
      '--mode',
      'json',
      '--session',
      desktopPath,
      '-p',
      'Continue from terminal',
    ])
    expect(resumed.stdout).toContain('agent_settled')
    expect(
      fixture.requests
        .at(-1)
        .messages.some((m) => JSON.stringify(m.content).includes('Discuss the harmonic oscillator')),
    ).toBe(true)
    app = await launch()
    page = await app.firstWindow()
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessionFile).toBe(source)
    expect(
      await page.evaluate((workspace) => window.desktop.sessions(workspace), fixture.workspace),
    ).toHaveLength(1)
    await expect(page.locator('.breadcrumbs')).toContainText('Research conversation')
    await expect(page.locator('html')).toHaveClass('dark')
    expect(
      (await page.evaluate(() => window.desktop.snapshot())).messages.some(
        (m) => m.role === 'user' && m.content?.some?.((c) => c.text === 'Continue from terminal'),
      ),
    ).toBe(true)
    expect(errors).toEqual([])
  } catch (error) {
    console.error('Original test failure:', error)
    if (app) await (await app.firstWindow()).screenshot({ path: 'test-results/failure.png' }).catch(() => {})
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
