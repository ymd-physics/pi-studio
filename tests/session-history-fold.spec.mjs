import { test, expect, _electron as electron } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('inactive history scrolls inside the disclosure; pinned and opened sessions stay outside', async () => {
  const f = await createFixture()
  let app
  try {
    const prefsFile = join(f.dataDir, 'preferences.json')
    const prefs = JSON.parse(await readFile(prefsFile, 'utf8'))
    const lines = (await readFile(prefs.activeSession, 'utf8')).trimEnd().split('\n')
    for (let i=0; i<12; i++) {
      const id = randomUUID(), path = join(dirname(prefs.activeSession), `${id}.jsonl`)
      const header = JSON.stringify({...JSON.parse(lines[0]), id})
      await writeFile(path, [header, ...lines.slice(1)].join('\n').replaceAll('Discuss the harmonic oscillator', `History ${i}`)+'\n')
      if (i === 0) prefs.workspaces[0].pinnedSessions = [path]
    }
    await writeFile(prefsFile, JSON.stringify(prefs))
    app = await electron.launch({args:['.'], env:f.env})
    const page = await app.firstWindow(), toggle = page.getByRole('button', {name:'Other sessions 11'})
    await expect(toggle).toHaveAttribute('aria-expanded','false')
    await expect(page.locator('.session-link').filter({hasText:'History 0'})).toBeVisible()
    await toggle.click()
    const list = page.locator('.session-history-list')
    await expect(list.locator('.session-link')).toHaveCount(11)
    const hint = page.locator('.session-history-hint')
    await expect(list).toHaveCSS('scrollbar-width','none')
    await expect(hint).toHaveAccessibleName('Scroll down')
    await list.evaluate(el => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2 })
    await expect(hint).toHaveAccessibleName('Scroll up or down')
    expect(await list.evaluate(el => {el.scrollTop = el.scrollHeight; return el.scrollTop > 0 && el.clientHeight <= 190})).toBe(true)
    await expect(hint).toHaveAccessibleName('Scroll up')
    await list.locator('.session-link').last().click()
    await expect(page.locator('.session-link.selected')).toContainText('History')
    await expect(list.locator('.session-link')).toHaveCount(10)
    await page.locator('.history-fold').click()
    await expect(list).toHaveCount(0)
    await expect(page.locator('.session-link.selected')).toBeVisible()
  } finally { if(app) await app.close(); await f.dispose() }
})
