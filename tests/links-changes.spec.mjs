import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFixture } from './fixture.mjs'

test('local links, bounded image previews and actual native write/edit changes', async () => {
  const changedPath = 'agent_files/index-fix-verification/detailed-verification-notes-for-the-reference-corrections.txt'
  const fixture = await createFixture({ completion: body => {
    const last = body.messages.at(-1)
    const user = body.messages.filter(m => m.role === 'user').at(-1)
    if (!JSON.stringify(user).includes('SHOW_FILE_CHANGES')) return
    const call = (name, args, id = name + '-fixture') => ({ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, reason: 'tool_calls' })
    if (last.role !== 'tool') return call('write', { path: changedPath, content: 'alpha\nbeta\n' })
    if (last.tool_call_id === 'write-fixture') return call('edit', { path: changedPath, edits: [{ oldText: 'beta', newText: 'gamma\ndelta' }] })
    if (last.tool_call_id === 'edit-fixture') return call('edit', { path: 'notes.md', edits: [{ oldText: '# Research notes', newText: '# Verified research notes\n\nReferences checked.' }] }, 'edit-second-fixture')
  } })
  let app
  try {
    const image = join(fixture.workspace, 'plots/图 # 100%.png')
    const outside = join(fixture.root, 'outside.png')
    await mkdir(join(fixture.workspace, 'plots'))
    await writeFile(join(fixture.workspace, 'report.pdf'), 'Isolated fixture, never opened by a real external app')
    await symlink(outside, join(fixture.workspace, 'outside-link.png'))
    const markdown = `[Relative PDF](report.pdf) · [Absolute PDF](<${join(fixture.workspace, 'report.pdf')}>) · [File URL](${pathToFileURL(join(fixture.workspace, 'report.pdf')).href}) · [Website](https://example.com)\n\n![Local plot](plots/${encodeURIComponent('图 # 100%.png')})\n\n![Outside plot](outside-link.png)\n\n![Remote plot](https://example.com/tracker.png)`
    await writeFile(join(fixture.workspace, 'plots/view.md'), '![Document-relative image](' + encodeURIComponent('图 # 100%.png') + ')')
    await writeFile(join(fixture.agentDir, 'extensions/link-check.ts'), `export default function(pi) { pi.registerCommand('show-links', {handler: async () => pi.sendMessage({customType:'link-check',content:${JSON.stringify(markdown)},display:true})}); }`)
    app = await electron.launch({ args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'], executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE, env: fixture.env })
    const png = await app.evaluate(({ nativeImage }) => {
      const pixels = Buffer.alloc(320 * 160 * 4)
      for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 180; pixels[i + 1] = 110; pixels[i + 2] = 60; pixels[i + 3] = 255 }
      return nativeImage.createFromBitmap(pixels, { width: 320, height: 160 }).toPNG().toString('base64')
    })
    await writeFile(image, Buffer.from(png, 'base64'))
    await writeFile(outside, Buffer.from(png, 'base64'))
    await app.evaluate(({ dialog, shell }) => {
      globalThis.linkPrompts = []; globalThis.openedFiles = []; globalThis.linkChoice = 0
      dialog.showMessageBox = async (_window, options) => { globalThis.linkPrompts.push(options); return { response: globalThis.linkChoice } }
      shell.openPath = async path => { globalThis.openedFiles.push(path); return '' }
      shell.openExternal = async url => { globalThis.openedFiles.push(url) }
    })
    const page = await app.firstWindow()
    const input = page.getByRole('textbox', { name: 'Message Pi' })
    await expect(input).toBeVisible()
    await input.fill('/show-links'); await input.press('Enter')
    const plot = page.getByRole('img', { name: 'Local plot', exact: true })
    await page.locator('.markdown-image').first().scrollIntoViewIfNeeded()
    await expect(plot).toBeVisible()
    expect(await plot.evaluate(el => el.naturalWidth)).toBe(320)
    expect(await app.evaluate(() => globalThis.linkPrompts.length)).toBe(0)
    await page.getByRole('link', { name: 'Relative PDF', exact: true }).click()
    expect(await app.evaluate(() => globalThis.openedFiles)).toEqual([])
    await app.evaluate(() => { globalThis.linkChoice = 1 })
    for (const label of ['Relative PDF', 'Absolute PDF', 'File URL']) await page.getByRole('link', { name: label, exact: true }).click()
    await expect.poll(() => app.evaluate(() => globalThis.openedFiles)).toEqual(Array(3).fill(join(fixture.workspace, 'report.pdf')))
    await page.locator('.markdown-image').first().getByRole('link', { name: 'Open original' }).click()
    await expect.poll(() => app.evaluate(() => globalThis.openedFiles.at(-1))).toBe(image)
    await page.locator('.markdown-image').nth(1).scrollIntoViewIfNeeded()
    const prompts = await app.evaluate(() => globalThis.linkPrompts.length)
    await expect(page.getByRole('img', { name: 'Outside plot', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Load image outside workspace' }).click()
    await expect(page.getByRole('img', { name: 'Outside plot', exact: true })).toBeVisible()
    expect(await app.evaluate(() => globalThis.linkPrompts.length)).toBe(prompts + 1)
    await expect(page.getByRole('img', { name: 'Remote plot', exact: true })).toHaveCount(0)
    await page.screenshot({ path: 'test-results/local-images.png' })
    const initial = await page.evaluate(() => window.desktop.snapshot())
    await expect(page.evaluate(({ handle }) => window.desktop.openLocalLink(handle, 'javascript:alert(1)'), initial)).rejects.toThrow()
    await expect(page.evaluate(() => window.desktop.previewLocalImage('missing-session', 'notes.md'))).rejects.toThrow()

    await page.getByRole('button', { name: 'Toggle files' }).click()
    await page.locator('.file-list').getByRole('button', { name: 'plots', exact: true }).click()
    await page.locator('.file-list').getByRole('button', { name: 'view.md', exact: true }).click()
    await expect(page.locator('.file-preview').getByRole('img', { name: 'Document-relative image' })).toBeVisible()
    await page.getByRole('button', { name: 'Close files' }).click()
    await input.fill('SHOW_FILE_CHANGES'); await input.press('Enter')
    await expect(page.locator('.session-link.selected')).toHaveAttribute('data-status', 'active')
    const group = page.locator('.tool-group').filter({ hasText: '3 tool calls' })
    const toggle = page.getByRole('button', { name: '3 tool calls', exact: true })
    await expect(group.locator('.tool-diff-tag')).toHaveText('Changes+5−2')
    await toggle.click()
    const write = group.locator('.tool-row > button').filter({ hasText: 'write' })
    const edits = group.locator('.tool-row > button').filter({ hasText: 'edit' })
    await expect(edits.nth(0).getByLabel('2 lines added, 1 line removed')).toBeVisible()
    await expect(edits.nth(1).getByLabel('3 lines added, 1 line removed')).toBeVisible()
    await expect(write.locator('.tool-write-count')).toHaveText('Written 2 lines')
    const before = await page.evaluate(() => window.desktop.snapshot())
    const history = await readFile(before.state.sessionFile, 'utf8')
    const requests = fixture.requests.length
    await write.click()
    await expect(page.getByLabel('File change details').first()).toContainText('Submitted content — write succeeded')
    await edits.nth(0).click()
    await expect(page.getByText('Native edit diff — reported by tool')).toBeVisible()
    await expect(page.locator('.change-deleted code')).toContainText('beta')
    await expect(page.locator('.change-added code').filter({ hasText: 'gamma' })).toBeVisible()
    await toggle.click()
    await expect(group.locator('.tool-call-changes')).toHaveCount(0)
    await toggle.click()
    await expect(page.getByText('Native edit diff — reported by tool')).toBeVisible()
    await edits.nth(0).click()
    await write.click()
    for (const dark of [false, true]) {
      await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), dark)
      for (const width of [1280, 680]) {
        await page.setViewportSize({ width, height: 850 })
        await expect(edits.nth(0).getByLabel('2 lines added, 1 line removed')).toBeVisible()
        await expect(write.locator('.tool-write-count')).toBeVisible()
        const bounds = await group.locator('.tool-row > button').evaluateAll((buttons) => buttons.map(button => {
          const row = button.getBoundingClientRect()
          const info = button.querySelector('.tool-info').getBoundingClientRect()
          const state = button.querySelector('.tool-state').getBoundingClientRect()
          const count = button.querySelector('.tool-call-changes, .tool-write-count').getBoundingClientRect()
          return info.right <= state.left + 1 && count.right <= info.right + 1 && state.right <= row.right + 1
        }))
        expect(bounds).toEqual([true, true, true])
        await group.screenshot({ path: `test-results/0.9.5-tool-counts-${dark ? 'dark' : 'light'}-${width}.png` })
      }
    }
    expect(fixture.requests.length).toBe(requests)
    expect(await readFile(before.state.sessionFile, 'utf8')).toBe(history)
    expect(await readFile(join(fixture.workspace, changedPath), 'utf8')).toBe('alpha\ngamma\ndelta\n')
    await page.setViewportSize({ width: 1280, height: 850 })
    await page.evaluate(() => document.documentElement.classList.remove('dark'))
    await write.click()
    await edits.nth(0).click()
    await page.screenshot({ path: 'test-results/native-file-changes.png' })
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByRole('button', { name: /^Theme/ }).click()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await page.getByRole('button', { name: 'Close preferences' }).click()
    await page.screenshot({ path: 'test-results/native-file-changes-dark.png' })
  } catch (error) {
    if (app) {
      const page = await app.firstWindow()
      await writeFile('test-results/links-debug.json', JSON.stringify({ snapshot: await page.evaluate(() => window.desktop.snapshot()), requests: fixture.requests }, null, 2))
      await page.screenshot({ path: 'test-results/links-debug.png' })
    }
    throw error
  } finally {
    if (app) { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {}); await app.close().catch(() => {}) }
    await fixture.dispose()
  }
})
