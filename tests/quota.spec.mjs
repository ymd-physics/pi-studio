import { test, expect, _electron as electron } from '@playwright/test'
import { createFixture } from './fixture.mjs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

test('built-in quota uses native auth detection and renders safe snapshots without a usage plugin', async () => {
  const fixture = await createFixture()
  let app
  try {
    // Register a model identity without real credentials. This test never prompts
    // it; abort any accidental provider request before it can leave the fixture.
    await writeFile(join(fixture.agentDir, 'extensions/quota-model.ts'), `
      export default function(pi) {
        pi.registerProvider('openai-codex', {
          baseUrl: 'https://chatgpt.com/backend-api', api: 'openai-codex-responses', apiKey: 'fixture-only',
          models: [{ id: 'quota-fixture', name: 'Quota fixture', reasoning: true, input: ['text'],
            contextWindow: 200000, maxTokens: 2000, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0} }],
        });
        pi.on('before_provider_request', (_event, ctx) => {
          if (ctx.model?.provider === 'openai-codex') ctx.abort();
        });
      }
    `)
    app = await electron.launch({
      args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
      executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
      env: fixture.env,
    })
    const page = await app.firstWindow()
    await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.desktop.codexUsage()).reason))
      .toBe('not-started')
    await expect(page.getByLabel('Codex subscription allowance')).toHaveCount(0)
    const requestsBefore = fixture.requests.length
    const model = page.getByLabel('Model', { exact: true })
    await model.selectOption('openai-codex/quota-fixture')
    // Native auth is inspected only after a supported model creates demand.
    await expect.poll(() => page.evaluate(async () => (await window.desktop.codexUsage()).reason))
      .toBe('no-subscription')
    // UI-only fixture data delivered over the real main/preload channel. HTTP/auth are
    // independently tested with injected credentials, never the user's subscription.
    const usage = {
      provider: 'openai-codex',
      state: 'ready',
      reason: null,
      capturedAt: Date.now(),
      stale: false,
      windows: [
        { durationSeconds: 18000, remainingPercent: 82, resetsAt: Math.floor(Date.now() / 1000) + 7200 },
        { durationSeconds: 604800, remainingPercent: 46, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 + 3600 },
      ],
    }
    await app.evaluate(
      ({ BrowserWindow }, usage) =>
        BrowserWindow.getAllWindows()[0].webContents.send('pi:event', { type: 'desktop_codex_usage', usage }),
      usage,
    )
    const meter = page.getByLabel('Codex subscription allowance')
    await expect(meter).toContainText('82% left')
    await expect(meter).toContainText('46% left')
    await expect(meter).toContainText('Resets in')
    await expect(page.locator('.quota-refresh')).toHaveCount(0)
    const footer = page.locator('.composer-footer')
    await expect(footer).toContainText('Send')
    await expect(footer).toContainText('Codex')
    const footerGap = () => footer.evaluate(el => el.getBoundingClientRect().top - el.parentElement.querySelector('.composer-card').getBoundingClientRect().bottom)
    await expect.poll(footerGap).toBe(10)
    const [quotaBox, hintsBox] = await Promise.all([meter.boundingBox(), page.locator('.composer-shortcuts').boundingBox()])
    expect(Math.abs(quotaBox.y - hintsBox.y)).toBeLessThan(10)
    await page.screenshot({ path: 'test-results/codex-quota.png' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 700))
    await expect.poll(footerGap).toBe(10)
    const narrow = await footer.boundingBox()
    expect(await footer.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(Math.ceil(narrow.width))
    await page.screenshot({ path: 'test-results/codex-quota-narrow.png' })
    await app.evaluate(
      ({ BrowserWindow }, usage) =>
        BrowserWindow.getAllWindows()[0].webContents.send('pi:event', {
          type: 'desktop_codex_usage',
          usage: { ...usage, state: 'error', stale: true, reason: 'rate-limited' },
        }),
      usage,
    )
    await expect(meter).toContainText('Update delayed')
    await expect(meter).toContainText('46% left')
    await app.evaluate(
      ({ BrowserWindow }, usage) =>
        BrowserWindow.getAllWindows()[0].webContents.send('pi:event', {
          type: 'desktop_codex_usage',
          usage: {
            ...usage,
            state: 'unavailable',
            stale: false,
            windows: [],
            reason: 'unsupported-subscription',
          },
        }),
      usage,
    )
    await expect(meter).toContainText('Quota unavailable')
    await expect(meter).not.toContainText('% left')
    await model.selectOption('desktop-test/test-model')
    await expect(model).toBeEnabled()
    await expect(meter).toHaveCount(0)
    await expect(footer).not.toContainText('Quota unavailable')
    await expect(footer).toContainText('Send')
    await expect.poll(() => page.evaluate(async () => (await window.desktop.codexUsage()).reason))
      .toBe('stopped')
    await model.selectOption('openai-codex/quota-fixture')
    await expect.poll(() => page.evaluate(async () => (await window.desktop.codexUsage()).reason))
      .toBe('no-subscription')
    const supported = (await page.evaluate(() => window.desktop.snapshot())).handle
    await page.getByRole('button', { name: 'New session in Research', exact: true }).click()
    await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click()
    await expect(page.locator(`.session-view[data-session-handle="${supported}"]`)).toBeHidden()
    const current = page.locator('.session-view:not([hidden])')
    await current.getByRole('combobox', { name: 'Model', exact: true }).selectOption('desktop-test/test-model')
    await expect.poll(() => page.evaluate(async () => (await window.desktop.snapshot()).state.model.provider))
      .toBe('desktop-test')
    // The hidden Codex session still needs polling even though this view does not.
    expect((await page.evaluate(() => window.desktop.codexUsage())).reason).toBe('no-subscription')
    await expect(meter).toHaveCount(0)
    await page.evaluate((handle) => window.desktop.closeSession(handle), supported)
    await expect.poll(() => page.evaluate(async () => (await window.desktop.codexUsage()).reason))
      .toBe('stopped')
    expect(fixture.requests).toHaveLength(requestsBefore)
  } catch (error) {
    if (app) {
      const page = await app.firstWindow()
      console.error(await page.locator('body').innerText())
    }
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
