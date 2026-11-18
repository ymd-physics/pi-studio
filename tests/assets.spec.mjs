import { test, expect, _electron as electron } from '@playwright/test'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('workspace file menus, native clipboard and image/file attachments', async () => {
  const fixture = await createFixture()
  let app
  try {
    const models = JSON.parse(await readFile(join(fixture.agentDir, 'models.json'), 'utf8'))
    models.providers['desktop-test'].models.forEach((m) => (m.input = ['text', 'image']))
    await writeFile(join(fixture.agentDir, 'models.json'), JSON.stringify(models))
    const original = join(fixture.root, '论文 sample.txt')
    await writeFile(original, 'Original remains intact')
    app = await electron.launch({
      args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
      executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
      env: fixture.env,
    })
    await app.evaluate(({ clipboard }) => {
      globalThis.__assetClipboard = {
        text: clipboard.readText(),
        html: clipboard.readHTML(),
        rtf: clipboard.readRTF(),
        image: clipboard.readImage(),
      }
      globalThis.__assetFiles = clipboard.readBuffer('NSFilenamesPboardType')
    })
    const page = await app.firstWindow()
    const input = page.getByRole('textbox', { name: 'Message Pi' })
    await expect(input).toBeVisible()
    const cdp = await page.context().newCDPSession(page)
    const drop = async (locator, path) => {
      const box = await locator.boundingBox()
      const data = { items: [], files: [path], dragOperationsMask: 1 }
      const position = { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 60), data }
      await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...position })
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...position })
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...position })
    }
    const dropped = join(fixture.root, 'dropped.txt')
    await writeFile(dropped, 'Copied, not moved')
    await drop(input, original)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('.path-reference, .attachment-chip')).toHaveCount(0)
    await drop(input, original)
    await page.getByRole('button', { name: 'Reference original' }).click()
    await expect(page.locator('.reference-name')).toHaveText('@论文 sample.txt')
    await expect(page.locator('.reference-name')).toHaveAttribute('title', '@' + original)
    await drop(input, fixture.agentDir)
    await expect(page.locator('.path-reference')).toHaveCount(2)
    await expect(page.locator('.drop-choice')).toHaveCount(0)
    await page.getByRole('button', { name: `Remove reference ${fixture.agentDir}`, exact: true }).click()
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => fixture.requests.at(-1)?.messages.at(-1)?.content && JSON.stringify(fixture.requests.at(-1).messages.at(-1).content)).toContain('@' + original)
    await expect(page.locator('.path-reference')).toHaveCount(0)
    expect(await readdir(join(fixture.workspace, '.pi/attachments')).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e))).toEqual([])
    await drop(input, original)
    await page.getByRole('button', { name: 'Copy to workspace', exact: true }).click()
    await expect(page.locator('.attachment-chip')).toContainText('论文 sample.txt')
    await page.getByRole('button', { name: 'Remove attachment 论文 sample.txt' }).click()
    const processesBefore = await page.evaluate(() => window.desktop.runningSessions())
    await drop(page.locator('.workspace-heading').first(), dropped)
    await expect
      .poll(() => readFile(join(fixture.workspace, 'dropped.txt'), 'utf8').catch(() => null))
      .toBe('Copied, not moved')
    expect(await readFile(dropped, 'utf8')).toBe('Copied, not moved')
    expect(await page.evaluate(() => window.desktop.runningSessions())).toEqual(processesBefore)
    await page.getByLabel('Attach files', { exact: true }).setInputFiles(original)
    await expect(page.locator('.attachment-chip')).toHaveCount(1)
    const pending = (await readdir(join(fixture.workspace, '.pi/attachments')))[0]
    expect(await readFile(join(fixture.workspace, '.pi/attachments', pending), 'utf8')).toBe(
      'Original remains intact',
    )
    await page.getByRole('button', { name: 'Remove attachment 论文 sample.txt' }).click()
    await expect(page.locator('.attachment-chip')).toHaveCount(0)
    expect(await readdir(join(fixture.workspace, '.pi/attachments'))).toEqual([])
    expect(await readFile(original, 'utf8')).toBe('Original remains intact')

    await page.getByRole('button', { name: 'Toggle files' }).click()
    const list = page.locator('.file-list')
    await list.getByRole('button', { name: 'example.py' }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).click()
    await input.click()
    await input.press('Meta+v')
    await expect(page.locator('.attachment-chip')).toContainText('example.py')
    await page.getByRole('button', { name: 'Remove attachment example.py' }).click()
    await list.click({ button: 'right', position: { x: 10, y: 150 } })
    await page.getByRole('menuitem', { name: 'New folder…' }).click()
    await page.getByRole('textbox', { name: 'File name' }).fill('copies')
    await page
      .getByRole('dialog', { name: 'New folder' })
      .getByRole('button', { name: 'Save', exact: true })
      .click()
    await list.getByRole('button', { name: 'copies' }).click()
    await drop(page.getByRole('complementary', { name: 'Workspace files' }), dropped)
    await expect(list.getByRole('button', { name: 'dropped.txt' })).toBeVisible()
    await list.click({ button: 'right', position: { x: 10, y: 20 } })
    await page.getByRole('menuitem', { name: 'Paste', exact: true }).click()
    await expect(list.getByRole('button', { name: 'example.py' })).toBeVisible()
    await list.getByRole('button', { name: 'example.py' }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename…' }).click()
    await page.getByRole('textbox', { name: 'File name' }).fill('renamed.py')
    await page
      .getByRole('dialog', { name: 'Rename file' })
      .getByRole('button', { name: 'Save', exact: true })
      .click()
    await expect(list.getByRole('button', { name: 'renamed.py' })).toBeVisible()
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await list.getByRole('button', { name: 'renamed.py' }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to Trash…' }).click()
    await expect(list.getByRole('button', { name: 'renamed.py' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Close files' }).click()

    const clipboardImage = await app.evaluate(({ clipboard, nativeImage }) => {
      const image = nativeImage.createFromBitmap(Buffer.from([255, 0, 0, 255]), { width: 1, height: 1 })
      clipboard.writeImage(image)
      return !clipboard.readImage().isEmpty()
    })
    expect(clipboardImage).toBe(true)
    await input.click()
    await input.press('Meta+v')
    await expect(page.locator('.attachment-chip img')).toHaveCount(1)
    await page.getByLabel('Attach files', { exact: true }).setInputFiles(original)
    await expect(page.locator('.attachment-chip')).toHaveCount(2)
    await input.fill('Describe this image and read the attached file')
    await input.press('Enter')
    await expect(page.locator('.attachment-chip')).toHaveCount(0)
    await expect
      .poll(() => JSON.stringify(fixture.requests.at(-1)?.messages))
      .toContain('data:image/png;base64,')
    expect(JSON.stringify(fixture.requests.at(-1).messages)).toContain('.pi/attachments/')
    expect((await readdir(join(fixture.workspace, '.pi/attachments'))).length).toBe(2)
    // Wait for settlement before hovering a control whose position changes when
    // the composer switches from Stop to Send.
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0)
    await expect(page.locator('.run-metrics').last()).toBeVisible()
    // Display-only surfaces read the native image blocks and the attachment path block.
    await expect(page.getByRole('button', { name: 'Open pasted-image.png' })).toBeVisible()
    await expect
      .poll(() =>
        page
          .locator('.message-attachments .image-card img')
          .evaluate((image) => image.naturalWidth),
      )
      .toBeGreaterThan(0)
    await expect(page.getByText('论文 sample.txt', { exact: true })).toBeVisible()
    await expect(page.locator('.message-attachments .file-card')).toContainText(/TXT file · \d+ B/)
    const contextRing = page.getByRole('button', { name: /^Context window:/ })
    await contextRing.hover()
    await expect(page.getByRole('tooltip')).toContainText('128k')
    await page.screenshot({ path: 'test-results/0.8.1-context-light.png' })
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByRole('button', { name: /^Theme/ }).click()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await page.getByRole('button', { name: 'Close preferences' }).click()
    await contextRing.hover()
    await page.screenshot({ path: 'test-results/0.8.1-context-dark.png' })
  } finally {
    if (app) {
      await app.evaluate(({ clipboard, BrowserWindow }) => {
        if (globalThis.__assetFiles?.length)
          clipboard.writeBuffer('NSFilenamesPboardType', globalThis.__assetFiles)
        else if (globalThis.__assetClipboard) clipboard.write(globalThis.__assetClipboard)
        BrowserWindow.getAllWindows().forEach((w) => w.destroy())
      })
      await app.close()
    }
    await fixture.dispose()
  }
})
