import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

test('temporary native terminal: completion, direct input, workspace UI, fonts and lifecycle', async () => {
  const fixture = await createFixture()
  const env = { ...fixture.env, HOME: fixture.root, ZDOTDIR: fixture.root, SHELL: '/bin/zsh', TERMINAL_EXPECTED: 'inherited-fixture' }
  await writeFile(join(fixture.root, '.zshrc'), `PROMPT='fixture> '\nHISTFILE=$HOME/history\nautoload -Uz compinit; compinit -i -D\n_proofargs() { compadd alpha alpine beta; }\nproofcmd() { print -r -- "$*"; }\ncompdef _proofargs proofcmd\n`)
  await writeFile(join(fixture.workspace, 'space file.txt'), '')
  await mkdir(join(fixture.workspace, 'space folder'))
  let app
  const errors = [], requestsBefore = fixture.requests.length
  try {
    app = await electron.launch({ args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'], executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE, env, timeout: 20000 })
    let page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(String(error)))
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    const ai = await page.evaluate(() => window.desktop.snapshot())
    await page.evaluate(() => { window.__terminalOutput = ''; window.desktop.terminal.onOutput((packet) => { window.__terminalOutput += packet.data }) })
    await page.getByRole('button', { name: 'New session in Research' }).click()
    await expect(page.locator('#workspace-creation-menu .context-menu-title')).toHaveCount(0)
    await page.getByRole('menuitem', { name: 'New terminal', exact: true }).click()
    const view = page.locator('.terminal-view:not([hidden])')
    await expect(view).toBeVisible()
    const row = page.locator('.terminal-link.selected')
    const id = await row.getAttribute('data-terminal-id')
    const ready = () => expect.poll(() => page.evaluate(async (id) => (await window.desktop.terminals()).find((item) => item.id === id)?.mode, id)).toBe('command')
    await ready()
    const editor = view.getByRole('textbox', { name: 'Terminal command' })
    await editor.fill('proofcmd al')
    await editor.press('Tab')
    await expect(view.getByRole('listbox', { name: 'Native completions' })).toBeVisible()
    await expect(view.getByRole('option')).toHaveCount(2)
    expect(await page.evaluate(() => window.__terminalOutput)).not.toContain('proofcmd al')
    await editor.press('ArrowDown')
    await expect(view.getByRole('option').nth(0)).toHaveAttribute('aria-selected', 'true')
    await editor.press('ArrowDown')
    await expect(view.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
    await editor.press('ArrowUp')
    await editor.press('Enter')
    await expect(editor).toHaveValue('proofcmd alpha ')
    await expect(view.getByRole('listbox')).toHaveCount(0)
    expect(await page.evaluate(() => window.__terminalOutput)).not.toContain('proofcmd alpha')
    await editor.press('Control+u')
    await expect(editor).toHaveValue('')
    await editor.fill('cancel this draft')
    await editor.press('Control+c')
    await expect(editor).toHaveValue('')
    await editor.fill("printf '%s' \"$TERMINAL_EXPECTED\" > terminal-env")
    await editor.press('Enter')
    await expect(editor).toHaveValue('')
    await ready()
    await expect.poll(() => readFile(join(fixture.workspace, 'terminal-env'), 'utf8').catch(() => '')).toBe('inherited-fixture')
    await expect(view.locator('.xterm-rows')).toContainText('Completed ·')
    await expect.poll(() => view.locator('.xterm-rows').evaluate((rows) => [...rows.querySelectorAll('span')].some((span) => span.textContent.includes('printf') && Number(getComputedStyle(span).fontWeight) >= 600))).toBe(true)
    await expect(view.getByRole('group', { name: 'Terminal font size' }).getByRole('button')).toHaveCount(2)
    await page.getByRole('button', { name: 'Workspace information for Research' }).click()
    const workspaceDialog = page.getByRole('dialog', { name: 'Workspace information' })
    await workspaceDialog.getByRole('button', { name: 'Rename workspace…' }).click()
    await workspaceDialog.getByLabel('Display name').fill('Quantum lab')
    await workspaceDialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(workspaceDialog.locator('.pp-heading')).toContainText('Quantum lab')
    await expect(workspaceDialog.getByRole('button', { name: /Local/ })).toBeVisible()
    await workspaceDialog.getByRole('button', { name: 'Close workspace information' }).click()
    await expect(view.locator('.breadcrumbs')).toContainText('Quantum lab')
    expect((await page.evaluate(() => window.desktop.boot())).preferences.workspaces[0]).toMatchObject({ name: 'Quantum lab', path: fixture.workspace })
    await editor.fill('cat space')
    await editor.press('Tab')
    await expect(view.getByRole('option')).toHaveCount(2)
    await editor.press('Escape')
    await editor.fill('kept draft')
    for (const dark of [false, true]) {
      await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), dark)
      for (const width of [1280, 760]) {
        await page.setViewportSize({ width, height: 820 })
        await expect(editor).toHaveCSS('font-size', width <= 760 ? '14px' : '15px')
        const geometry = await view.evaluate((element) => {
          const output = element.querySelector('.terminal-view__output').getBoundingClientRect()
          const shelf = element.querySelector('.terminal-view__shelf').getBoundingClientRect()
          const bounds = element.getBoundingClientRect()
          return { fits: shelf.right <= bounds.right && output.right <= bounds.right && output.left > bounds.left, separated: shelf.top >= output.bottom, font: getComputedStyle(element.querySelector('textarea[aria-label="Terminal command"]')).fontSize }
        })
        expect(geometry.fits).toBe(true); expect(geometry.separated).toBe(true)
        expect(geometry.font).toBe(width <= 760 ? '14px' : '15px')
        await view.screenshot({ path: `test-results/terminal-${dark ? 'dark' : 'light'}-${width}.png` })
      }
    }
    await page.setViewportSize({ width: 1280, height: 820 })
    await view.getByRole('button', { name: 'Increase terminal font size' }).click()
    await expect.poll(() => page.evaluate(async () => (await window.desktop.boot()).preferences.terminalFontSize)).toBe(16)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.2))
    await expect(editor).toHaveCSS('font-size', '16px') // CSS pixels are not multiplied by DPR or zoom again.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
    // CDP does not drive macOS native menu accelerators. The real webContents
    // zoom above tests scaling; unit tests verify Cmd +/-/0 bypass xterm unchanged.
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename…' }).click()
    await page.getByRole('textbox', { name: 'Terminal name' }).fill('Experiment')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(row).toContainText('Experiment')
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Clear output' }).click()
    await expect(editor).toHaveValue('kept draft')
    await editor.fill("printf '%s ' $$ > terminal-owned.pid; /bin/sh -c 'printf %s $$ >> terminal-owned.pid; exec sleep 60'")
    await editor.press('Enter')
    await expect.poll(async () => { try { return (await readFile(join(fixture.workspace, 'terminal-owned.pid'), 'utf8')).trim().split(' ').map(Number).length } catch { return 0 } }).toBe(2)
    const pids = (await readFile(join(fixture.workspace, 'terminal-owned.pid'), 'utf8')).trim().split(' ').map(Number)
    expect(pids.every(alive)).toBe(true)
    await expect(editor).toBeHidden()
    await page.locator('.session-link:not(.terminal-link)').filter({ hasText: 'Discuss the harmonic oscillator' }).click()
    expect(pids.every(alive)).toBe(true)
    await row.click()
    await expect(view).toBeVisible()
    await view.getByRole('button', { name: 'Draft next command', exact: true }).click()
    await editor.fill('cancel draft and foreground')
    await editor.press('Control+c')
    await ready()
    await expect(editor).toHaveValue('')
    await expect.poll(() => alive(pids[1])).toBe(false)
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }) })
    await view.getByRole('button', { name: 'Close terminal', exact: true }).click()
    await expect(row).toBeVisible()
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }) })
    await view.getByRole('button', { name: 'Close terminal', exact: true }).click()
    await expect(page.locator('.terminal-link')).toHaveCount(0)
    await expect.poll(() => pids.some(alive)).toBe(false)
    expect(fixture.requests).toHaveLength(requestsBefore)
    expect(await readFile(ai.state.sessionFile, 'utf8')).not.toContain('terminal-env')
    expect(errors).toEqual([])
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.destroy())).catch(() => {})
      await app.close().catch(() => {})
    }
    await fixture.dispose()
  }
})

test('confirmed quit ends every temporary terminal and restores only AI history and shared preferences', async () => {
  const fixture = await createFixture()
  const env = { ...fixture.env, HOME: fixture.root, ZDOTDIR: fixture.root, SHELL: '/bin/zsh' }
  await writeFile(join(fixture.root, '.zshrc'), 'PROMPT="fixture> "\nHISTFILE=$HOME/history\nSAVEHIST=0\n')
  await writeFile(join(fixture.root, 'history'), 'keep-existing-history\n')
  let app
  const launch = () => electron.launch({ args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'], executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE, env, timeout: 20000 })
  try {
    app = await launch()
    let page = await app.firstWindow()
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    const ai = await page.evaluate(() => window.desktop.snapshot())
    const original = await readFile(ai.state.sessionFile, 'utf8')
    await page.evaluate(() => window.desktop.preferences({ terminalFontSize: 18 }))
    await page.evaluate((workspace) => window.desktop.renameWorkspace(workspace, 'Persistent workspace name'), fixture.workspace)
    const pids = []
    for (let i = 0; i < 2; i++) {
      const info = await page.evaluate((workspace) => window.desktop.createTerminal(workspace), fixture.workspace)
      await expect.poll(() => page.evaluate(async (id) => (await window.desktop.terminals()).find((item) => item.id === id)?.mode, info.id)).toBe('command')
      await page.evaluate(({ id, i }) => window.desktop.terminal.submit(id, `printf '%s ' $$ > quit-${i}.pid; /bin/sh -c 'printf %s $$ >> quit-${i}.pid; exec sleep 60'`), { id: info.id, i })
      await expect.poll(() => readFile(join(fixture.workspace, `quit-${i}.pid`), 'utf8').catch(() => '')).toMatch(/^\d+ \d+$/)
      pids.push(...(await readFile(join(fixture.workspace, `quit-${i}.pid`), 'utf8')).split(' ').map(Number))
    }
    expect(pids.every(alive)).toBe(true)
    const closed = app.waitForEvent('close')
    await app.evaluate(({ app, dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); app.quit() })
    await closed; app = undefined
    await expect.poll(() => pids.some(alive)).toBe(false)
    expect(await readFile(join(fixture.root, 'history'), 'utf8')).toBe('keep-existing-history\n')
    app = await launch(); page = await app.firstWindow()
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    expect(await page.evaluate(() => window.desktop.terminals())).toEqual([])
    const restored = (await page.evaluate(() => window.desktop.boot())).preferences
    expect(restored.terminalFontSize).toBe(18)
    expect(restored.workspaces[0]).toMatchObject({ name: 'Persistent workspace name', path: fixture.workspace })
    expect(await readFile(ai.state.sessionFile, 'utf8')).toBe(original)
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.destroy())).catch(() => {})
      await app.close().catch(() => {})
    }
    await fixture.dispose()
  }
})
