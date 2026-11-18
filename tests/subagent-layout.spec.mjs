import { test, expect, _electron as electron } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('Task docket separates status from the composer across states and container widths', async () => {
  const fixture = await createFixture()
  let app
  try {
    // UI-only status fixture via native extension UI transport; real delegation is tested separately.
    await writeFile(join(fixture.agentDir, 'extensions/docket-fixture.ts'), `
      export default function(pi) {
        pi.registerCommand('docket-fixture', {handler: async (_, ctx) => {
          const now = Date.now();
          ctx.ui.setWidget('__pi_desktop_subagents_v1__', [JSON.stringify({ availability: 'available', updatedAt: now,
            agents: ['running','waiting','failed','paused','unknown','queued','stopped'].map((state, i) => ({
              id: 'docket-' + i, name: 'worker-' + i + '-with-a-long-display-name', state,
              task: 'Check the long conversation and preserve pending permission responses across concurrent workspace sessions',
              model: 'custom-provider/long-model-name-with-extended-context-window', thinking: 'high',
              activity: 'read · packages/desktop/session-lifecycle-integration.test.ts · 143 tools',
              ...(state === 'unknown' ? {} : { startedAt: now - 230000 }),
              ...(['failed','paused','stopped'].includes(state) ? { endedAt: now } : {})
            })) })]);
        }});
      }
    `)
    app = await electron.launch({ args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'], executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE, env: fixture.env })
    const page = await app.firstWindow()
    const input = page.getByRole('textbox', { name: 'Message Pi' })
    await expect(input).toBeVisible()
    await input.fill('/docket-fixture')
    await input.press('Enter')
    const shelf = page.getByRole('region', { name: 'Subagent activity' })
    await expect(shelf).toBeVisible()
    await input.fill('Keep this unsent draft.')
    for (const theme of ['Light', 'Dark']) {
      await page.getByRole('button', { name: 'Preferences', exact: true }).click()
      await page.getByRole('button', { name: /^Theme/ }).click()
      await page.getByRole('button', { name: theme, exact: true }).click()
      await page.getByRole('button', { name: 'Close preferences' }).click()
      for (const width of [1200, 680]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 820), width)
        // Step through every retained state, including missing timing and off-page attention.
        while (await shelf.getByRole('button', { name: 'Previous agent' }).isEnabled()) await shelf.getByRole('button', { name: 'Previous agent' }).click()
        for (let index = 0; index < 7; index++) {
          await expect(shelf.locator('.subagent-focus-pager span')).toHaveText(`${index + 1} / 7`)
          const layout = await shelf.evaluate(el => {
            const card = el.querySelector('.subagent-focus-card')
            const style = getComputedStyle(card)
            const status = el.querySelector('.subagent-focus-status')
            const composer = document.querySelector('.session-view:not([hidden]) .composer-card') || [...document.querySelectorAll('.composer-card')].find(el => el.getBoundingClientRect().width)
            const cardBox = card.getBoundingClientRect()
            return { fill: style.backgroundColor, radius: style.borderRadius, border: style.borderTopWidth,
              shelfOverflow: el.scrollWidth > el.clientWidth, statusOverflow: status.scrollWidth > status.clientWidth,
              composerRadius: getComputedStyle(composer).borderRadius, gap: composer.getBoundingClientRect().top - el.getBoundingClientRect().bottom,
              narrow: el.clientWidth <= 520, activityBelow: el.querySelector('.subagent-focus-activity').getBoundingClientRect().top > el.querySelector('.subagent-focus-meta').getBoundingClientRect().bottom,
              width: cardBox.width }
          })
          expect(layout.fill).toBe('rgba(0, 0, 0, 0)')
          expect(layout.radius).toBe('0px')
          expect(layout.border).toBe('0px')
          expect(layout.composerRadius).toBe('28px')
          expect(layout.shelfOverflow).toBe(false)
          expect(layout.statusOverflow).toBe(false)
          expect(layout.gap).toBeGreaterThanOrEqual(10)
          if (layout.narrow) expect(layout.activityBelow).toBe(true)
          if (index === 4) await expect(shelf.locator('.subagent-focus-elapsed')).toHaveText('Time unavailable')
          if (index === 1) await page.screenshot({ path: `test-results/task-docket-${theme.toLowerCase()}-${width}.png` })
          if (index < 6) await shelf.getByRole('button', { name: 'Next agent' }).click()
        }
        await shelf.getByRole('button', { name: /needs attention/ }).click()
        await expect(shelf.locator('.subagent-focus-state')).toHaveText('Needs attention')
        await expect(input).toHaveValue('Keep this unsent draft.')
      }
    }
  } finally {
    if (app) { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {}); await app.close().catch(() => {}) }
    await fixture.dispose()
  }
})
