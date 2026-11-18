import { test, expect, _electron as electron } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

const launch = (fixture) => electron.launch({
  args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
  executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
  env: fixture.env,
})
async function prepareImages(app, fixture) {
  // Actual local rasters with visible borders, including the reported 832:96 ratio.
  const images = await app.evaluate(({ nativeImage }) =>
    [['sample.png', 832, 96], ['portrait.png', 120, 240], ['landscape.png', 240, 150]].map(([name, width, height]) => {
      const bytes = Buffer.alloc(width * height * 4)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4
        const edge = x < 5 || y < 5 || x >= width - 5 || y >= height - 5
        bytes[offset] = edge ? 70 : 220 - Math.round(60 * x / width)
        bytes[offset + 1] = edge ? 90 : 230 - Math.round(50 * y / height)
        bytes[offset + 2] = edge ? 150 : 245
        bytes[offset + 3] = 255
      }
      return { name, width, height, data: nativeImage.createFromBitmap(bytes, { width, height }).toPNG().toString('base64') }
    }),
  )
  for (const image of images) {
    image.path = join(fixture.workspace, image.name)
    await writeFile(image.path, Buffer.from(image.data, 'base64'))
  }
  return images
}
async function enableImageModel(fixture) {
  const path = join(fixture.agentDir, 'models.json')
  const models = JSON.parse(await readFile(path, 'utf8'))
  models.providers['desktop-test'].models.forEach((model) => { model.input = ['text', 'image'] })
  await writeFile(path, JSON.stringify(models))
}
async function expectCompactCards(cards, width, frameHeight) {
  let geometry = []
  // A resize/DPR change first updates CSS, then requests and decodes a new preview.
  // Capture settled geometry in the same poll, not a previously loaded old image.
  await expect.poll(async () => {
    geometry = await cards.evaluateAll((cards) => cards.map((card) => {
      const frame = card.querySelector('.image-frame'), image = card.querySelector('img')
      if (!image || !image.complete || !image.naturalWidth) return { loaded: false }
      const box = card.getBoundingClientRect(), bounds = frame.getBoundingClientRect(), picture = image.getBoundingClientRect()
      return {
        loaded: true, width: box.width, height: box.height, frameHeight: bounds.height,
        cssFrameHeight: getComputedStyle(frame).height,
        fit: getComputedStyle(image).objectFit,
        completeRatio: Math.abs(picture.width / picture.height - image.naturalWidth / image.naturalHeight) < .02,
        contained: picture.width <= bounds.width + 1 && picture.height <= bounds.height + 1,
        notUpscaled: picture.width <= image.naturalWidth + 1 && picture.height <= image.naturalHeight + 1,
        preview: { naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
          budgetWidth: Math.ceil(frame.clientWidth * Math.min(3, window.devicePixelRatio)),
          budgetHeight: Math.ceil(frame.clientHeight * Math.min(3, window.devicePixelRatio)) },
        previewFitsPixels: image.naturalWidth <= Math.ceil(frame.clientWidth * Math.min(3, window.devicePixelRatio)) &&
          image.naturalHeight <= Math.ceil(frame.clientHeight * Math.min(3, window.devicePixelRatio)),
      }
    }))
    const pending = geometry.filter((item) => !item.loaded || !item.previewFitsPixels || !item.completeRatio)
    return geometry.length && !pending.length ? 'ready' : JSON.stringify(pending)
  }).toBe('ready')
  for (const item of geometry) {
    expect(item.width).toBeCloseTo(width, 0)
    expect(item.height).toBeLessThanOrEqual(130)
    expect(item.cssFrameHeight).toBe(`${frameHeight}px`)
    // DOMRects can carry subpixel rounding during the existing hover transform.
    expect(item.frameHeight).toBeCloseTo(frameHeight, 2)
    expect(item.fit).toBe('contain')
    expect(item.completeRatio).toBe(true)
    expect(item.contained).toBe(true)
    expect(item.notUpscaled).toBe(true)
    expect(item.previewFitsPixels, JSON.stringify(item.preview)).toBe(true)
  }
}
async function close(app, fixture) {
  if (app) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.destroy())).catch(() => {})
    await app.close().catch(() => {})
  }
  await fixture.dispose()
}

test('compact tool image disclosure and lightbox are display-only and independent of user attachments', async () => {
  const prompt = 'Inspect the fixture image with mixed tools'
  const fixture = await createFixture({ completion: (body) => {
    if (!JSON.stringify(body.messages).includes(prompt)) return
    // Inspect history, not a completion counter or the final message role: Pi may
    // represent image tool output with an additional user image message.
    if (body.messages.some((message) => message.tool_calls?.some((call) => call.id === 'fixture-image-0'))) {
      return { delta: { content: 'Fixture image reads complete.' } }
    }
    return {
      delta: { tool_calls: ['sample.png', 'portrait.png', 'landscape.png', 'notes.md'].map((path, index) => ({
        index, id: `fixture-image-${index}`, type: 'function',
        function: { name: 'read', arguments: JSON.stringify({ path }) },
      })) },
      reason: 'tool_calls',
    }
  } })
  let app
  try {
    await enableImageModel(fixture)
    app = await launch(fixture)
    const images = await prepareImages(app, fixture)
    const page = await app.firstWindow()
    const input = page.getByRole('textbox', { name: 'Message Pi' })
    await expect(input).toBeVisible()
    await page.getByLabel('Attach files', { exact: true }).setInputFiles(images[0].path)
    await expect(page.locator('.attachment-chip img')).toHaveCount(1)
    await input.fill(prompt)
    await input.press('Enter')
    await expect(page.getByText('Fixture image reads complete.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0)
    expect(fixture.requests).toHaveLength(3) // seed, tool calls, final answer

    const group = page.getByRole('region', { name: '4 tool calls' })
    const toggle = group.getByRole('button', { name: '4 tool calls', exact: true })
    const attachment = page.getByRole('group', { name: 'Attached images', exact: true })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(group.getByLabel('Tool breakdown')).toContainText('images3')
    await expect(group.getByRole('group', { name: 'Tool result images' })).toHaveCount(0)
    await expect(group.locator('img')).toHaveCount(0)
    await expect(attachment.getByRole('button', { name: 'Open sample.png' })).toBeVisible()
    await expectCompactCards(attachment.locator('.image-card'), 130, 78)

    const preferences = JSON.parse(await readFile(join(fixture.dataDir, 'preferences.json'), 'utf8'))
    const historyBefore = await readFile(preferences.activeSession, 'utf8')
    const requestsBefore = fixture.requests.length
    await toggle.click()
    const grid = group.getByRole('group', { name: 'Tool result images' })
    await expect(grid.locator('img')).toHaveCount(3)
    await expectCompactCards(grid.locator('.image-card'), 130, 78)
    const opener = grid.getByRole('button', { name: 'Open sample.png' })
    await expect(opener.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/)
    await opener.click()
    const dialog = page.getByRole('dialog', { name: 'Image: sample.png' })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('img')).toHaveAttribute('src', `data:image/png;base64,${images[0].data}`)
    await expect(dialog.getByRole('button', { name: 'Close image' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: 'Close image' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
    for (const dark of [false, true]) {
      await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), dark)
      for (const width of [1280, 680]) {
        await page.setViewportSize({ width, height: 850 })
        await expectCompactCards(grid.locator('.image-card'), width > 760 ? 130 : 118, width > 760 ? 78 : 70)
        await expectCompactCards(attachment.locator('.image-card'), width > 760 ? 130 : 118, width > 760 ? 78 : 70)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await group.screenshot({ path: `test-results/0.9.4-tool-images-${dark ? 'dark' : 'light'}-${width}.png` })
      }
    }
    await toggle.click()
    await expect(grid).toHaveCount(0)
    await expect(group.locator('img')).toHaveCount(0)
    await expect(group.getByLabel('Tool breakdown')).toContainText('images3')
    await expect(attachment.getByRole('button', { name: 'Open sample.png' })).toBeVisible()
    await toggle.click()
    await expect(grid.locator('img')).toHaveCount(3)
    expect(fixture.requests).toHaveLength(requestsBefore)
    expect(await readFile(preferences.activeSession, 'utf8')).toBe(historyBefore)
  } finally {
    await close(app, fixture)
  }
})

test('mixed user images and ordinary files use small wrapping cards without a single-image enlargement', async () => {
  const fixture = await createFixture()
  let app
  try {
    await enableImageModel(fixture)
    app = await launch(fixture)
    const images = await prepareImages(app, fixture)
    const file = join(fixture.workspace, 'spectrum-analysis-reference-final-results.py')
    await writeFile(file, '# An ordinary attachment, never previewed as document contents.\n')
    const page = await app.firstWindow()
    const input = page.getByRole('textbox', { name: 'Message Pi' })
    await expect(input).toBeVisible()
    await page.getByLabel('Attach files', { exact: true }).setInputFiles([...images.map((image) => image.path), file])
    await expect(page.locator('.attachment-chip')).toHaveCount(4)
    await input.fill('Keep these image and file attachments compact.')
    await input.press('Enter')
    const attachment = page.locator('.message-attachments')
    await expect(attachment.locator('.image-card')).toHaveCount(3)
    await expect(attachment.locator('.file-card')).toContainText(/PY file · \d+ B/)
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0)
    for (const dark of [false, true]) {
      await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), dark)
      for (const width of [1280, 680]) {
        await page.setViewportSize({ width, height: 850 })
        await expectCompactCards(attachment.locator('.image-card'), width > 760 ? 130 : 118, width > 760 ? 78 : 70)
        const chip = await attachment.locator('.file-card').boundingBox()
        expect(chip.width).toBeLessThanOrEqual(230)
        expect(chip.height).toBeLessThanOrEqual(44)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await attachment.screenshot({ path: `test-results/0.9.4-attachments-${dark ? 'dark' : 'light'}-${width}.png` })
      }
    }
  } finally {
    await close(app, fixture)
  }
})
