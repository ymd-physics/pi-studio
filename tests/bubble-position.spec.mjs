import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

test('drag clamps, reopens on the saved side after restart, and round-trips macOS full screen', async () => {
  const fixture = await createFixture()
  let app
  const launch = async () => {
    app = await electron.launch({ args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'], executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE, env: fixture.env })
    return app.firstWindow()
  }
  const stop = async () => {
    if (!app) return
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(()=>{})
    await app.close().catch(()=>{}); app = undefined
  }
  const enter = async page => {
    const opened = app.waitForEvent('window')
    await page.getByRole('button',{name:'Switch to desktop bubble'}).click()
    const bubble = await opened
    await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('bubble.html')).isVisible())).toBe(false)
    return bubble
  }
  const bounds = () => app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('bubble.html')).getBounds())
  try {
    const page=await launch()
    await expect(page.getByRole('textbox',{name:'Message Pi'})).toBeVisible()
    const full = process.platform==='darwin' && process.env.PI_TEST_FULLSCREEN==='1'
    if(full) { await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.focus();w.setFullScreen(true)});await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true) }
    const b=await enter(page)
    if(full) expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('bubble.html')).isFullScreen())).toBe(false)
    const initial=await bounds(),area=await app.evaluate(({screen},r)=>screen.getDisplayMatching(r).workArea,initial)
    const orb=await b.locator('.orb').boundingBox()
    await b.evaluate(async({initial,area,orb})=>{
      const start={x:initial.x+orb.x+42,y:initial.y+orb.y+42}, end={x:area.x+1,y:area.y+area.height-1}
      await window.bubble.drag('start',start);await window.bubble.drag('move',end);await window.bubble.drag('end',end)
    },{initial,area,orb})
    const saved=await bounds();expect(saved.x).toBe(area.x);expect(saved.y+saved.height).toBe(area.y+area.height)
    await b.locator('.orb').evaluate(el=>el.click());await expect(b.locator('aside')).toBeVisible()
    expect((await b.locator('aside').boundingBox()).x).toBeGreaterThan((await b.locator('.orb').boundingBox()).x+84)
    await b.evaluate(()=>{void window.bubble.restore()})
    await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length)).toBe(1)
    if(full) await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true)
    const stored=JSON.parse(await readFile(join(fixture.dataDir,'bubble-position.json'),'utf8'))
    expect(stored).toEqual({x:saved.x+16,y:saved.y+16})
    await stop();const second=await launch();const b2=await enter(second);await b2.waitForTimeout(700);const frame=await bounds(),glyph=await b2.locator('.orb').boundingBox();expect({x:frame.x+glyph.x,y:frame.y+glyph.y}).toEqual(stored)
  } finally {await stop();await fixture.dispose()}
})
