import { test, expect, _electron as electron } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('native Review Sheet preserves scope, drafts and context across sessions; expiry continues while reading', async () => {
  const fixture = await createFixture()
  let app
  try {
    await writeFile(
      join(fixture.agentDir, 'extensions/review-ui.ts'),
      `export default function(pi) {
      pi.registerCommand('review-select', {handler: async (_, ctx) => {
        const choice = await ctx.ui.select('Review this request', ['Only this request', 'Use this exact extension-defined response', 'Cancel this operation']);
        ctx.ui.notify('Review answer: '+String(choice), 'info');
      }});
      pi.registerCommand('review-input', {handler: async (_, ctx) => {
        const value = await ctx.ui.editor('Review notes', 'Original draft');
        ctx.ui.notify('Editor answer: '+String(value), 'info');
      }});
      pi.registerCommand('review-timeout', {handler: async (_, ctx) => {
        const value = await ctx.ui.confirm('Timed request', 'This request expires while reading too.', {timeout:1800});
        ctx.ui.notify('Timed answer: '+String(value), 'info');
      }});
    }`,
    )
    app = await electron.launch({
      args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
      executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
      env: fixture.env,
    })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700))
    const input = () => page.locator('.session-view:visible').getByRole('textbox', { name: 'Message Pi' })
    await expect(input()).toBeVisible()
    const initial = await page.evaluate(() => window.desktop.snapshot())
    const aRow = page.locator('.session-link.selected')
    await input().fill('/review-select')
    await input().press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Review this request' })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
    const exact = 'Use this exact extension-defined response'
    await page.getByRole('radio', { name: exact, exact: true }).check()
    await expect(page.locator('.session-notice').filter({ hasText: 'Review answer:' })).toHaveCount(0)
    const optionGeometry = await page.locator('.review-option').first().evaluate(el => ({
      radio: el.querySelector('input').getBoundingClientRect().width,
      text: el.querySelector('label span').getBoundingClientRect().width,
    }))
    expect(optionGeometry.radio).toBeLessThanOrEqual(16)
    expect(optionGeometry.text).toBeGreaterThan(80)
    await page.getByRole('button', { name: 'Read full request title' }).click()
    await page.getByRole('button', { name: 'Close full text' }).click()
    await expect(page.getByRole('button', { name: 'Read full request title' })).toBeFocused()
    await page.keyboard.press('Meta+l')
    await expect(page.getByRole('button', { name: 'Read full request title' })).toBeFocused()
    const colors = await page.evaluate(() =>
      [
        document.querySelector('.review-context-button'),
        document.querySelector('.review-actions > button:nth-child(2)'),
      ].map((el) => getComputedStyle(el).backgroundColor),
    )
    expect(colors[0]).not.toBe(colors[1])
    await page.screenshot({ path: 'test-results/review-sheet-light.png' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(680, 550))
    const bounds = await dialog.boundingBox()
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(680)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(550)
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeInViewport()
    await expect(page.getByRole('button', { name: 'View conversation', exact: true })).toBeInViewport()
    await page.screenshot({ path: 'test-results/review-sheet-narrow.png' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700))
    await page.getByRole('button', { name: 'View conversation', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('region', { name: 'Pending permission' })).toBeVisible()
    await expect(input()).toBeHidden()
    await expect(aRow).toHaveAttribute('data-status', 'waiting')
    const scroll = page.locator('.session-view:visible .conversation')
    await scroll.evaluate((el) => {
      el.scrollTop = 70
    })
    const position = await scroll.evaluate((el) => el.scrollTop)
    expect(position).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Return to review' })).toBeVisible()
    await page.screenshot({ path: 'test-results/review-sheet-reading.png' })
    await page.getByRole('button', { name: 'Return to review' }).click()
    await expect(page.getByRole('radio', { name: exact, exact: true })).toBeChecked()
    await page.getByRole('button', { name: 'View conversation', exact: true }).click()
    expect(await scroll.evaluate((el) => el.scrollTop)).toBe(position)
    await page.getByRole('button', { name: 'New session in Research' }).click()
    await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click()
    await expect(page.locator('.session-view:visible')).not.toHaveAttribute(
      'data-session-handle',
      initial.handle,
    )
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Pending permission' })).toHaveCount(0)
    await page.locator('.session-link').filter({ hasText: 'Discuss the harmonic oscillator' }).click()
    await expect(page.getByRole('button', { name: 'Return to review' })).toBeVisible()
    await page.getByRole('button', { name: 'Return to review' }).click()
    await expect(page.getByRole('radio', { name: exact, exact: true })).toBeChecked()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.locator('.session-notice').filter({ hasText: `Review answer: ${exact}` })).toBeVisible()
    await expect(page.locator('.session-link.selected')).toHaveAttribute('data-status', 'active')

    await input().fill('/review-input')
    await input().press('Enter')
    await page.getByRole('textbox', { name: 'Review notes' }).fill('Keep this edited draft')
    await page.getByRole('button', { name: 'View conversation', exact: true }).click()
    await page.getByRole('button', { name: 'Return to review' }).click()
    await expect(page.getByRole('textbox', { name: 'Review notes' })).toHaveValue('Keep this edited draft')
    await page.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect(
      page.locator('.session-notice').filter({ hasText: 'Editor answer: Keep this edited draft' }),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByRole('button', { name: /^Theme/ }).click()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await page.getByRole('button', { name: 'Close preferences' }).click()
    await input().fill('/review-timeout')
    await input().press('Enter')
    await expect(page.getByRole('dialog', { name: 'Timed request' })).toBeVisible()
    await page.screenshot({ path: 'test-results/review-sheet-dark.png' })
    await page.getByRole('button', { name: 'View conversation', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Pending permission' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Pending permission' })).toHaveCount(0)
    await expect(input()).toBeVisible()
    await expect(page.locator('.session-notice').filter({ hasText: 'Timed answer: false' })).toBeVisible()
    await expect(page.locator('.session-link.selected')).toHaveAttribute('data-status', 'active')
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
