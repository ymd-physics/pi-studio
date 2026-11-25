import {test,expect,_electron as electron} from '@playwright/test'
import {createFixture} from './fixture.mjs'

test('Studio remains interactive when restoring a partially populated assistant message', async () => {
  const fixture = await createFixture(); let app
  try {
    app = await electron.launch({args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'], executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE, env: fixture.env})
    const page = await app.firstWindow(), input = page.getByRole('textbox', {name:'Message Pi'})
    await expect(input).toBeVisible(); const errors = []; page.on('pageerror', e => errors.push(e.message))
    const handle = await page.evaluate(async () => (await window.desktop.snapshot()).handle)
    const opened = app.waitForEvent('window'); await page.getByRole('button', {name:'Switch to desktop bubble'}).click(); const bubble = await opened
    await expect.poll(() => app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().some(w => !w.isVisible() && w.webContents.getURL().endsWith('index.html')))).toBe(true)
    await app.evaluate(({BrowserWindow}, desktopSession) => {
      const wc = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html')).webContents
      wc.send('pi:event', {desktopSession,type:'message_start',message:{role:'assistant',timestamp:777,content:[]}})
      wc.send('pi:event', {desktopSession,type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:1,delta:'partial-slot-sentinel'}})
    }, handle)
    // Exercise the native return path directly: the transcript regression must not
    // depend on whether the transient bubble panel loses pointer focus in CI.
    await bubble.evaluate(() => { void window.bubble.restore() })
    await expect(page.locator('.conversation')).toContainText('partial-slot-sentinel'); await input.fill('still interactive')
    expect(errors).toEqual([])
  } finally { if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{})} await fixture.dispose() }
})

for(const midstream of [true,false]) test('hidden conversation catches up '+(midstream?'before settlement':'after settlement'),async()=>{
  let release, sent, app
  const received=new Promise(r=>sent=r), gate=new Promise(r=>release=r)
  const fixture=await createFixture({completion:()=>({delta:{content:'final-sentinel'}}),beforeFinalChunk:async (text,emit)=>{if(!text?.includes('stream check'))return;for(let i=0;i<64;i++)emit(`chunk${i};`);sent();await gate}})
  try{
    app=await electron.launch({args:process.env.PI_DESKTOP_TEST_EXECUTABLE?[]:['.'],executablePath:process.env.PI_DESKTOP_TEST_EXECUTABLE,env:fixture.env})
    const page=await app.firstWindow();await expect(page.getByRole('textbox',{name:'Message Pi'})).toBeVisible()
    const handle=await page.evaluate(async()=>(await window.desktop.snapshot()).handle)
    const opened=app.waitForEvent('window');await page.getByRole('button',{name:'Switch to desktop bubble'}).click();const bubble=await opened
    await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('bubble.html')).isVisible())).toBe(false)
    await page.evaluate(h=>{window.finished=window.desktop.command('prompt',{message:'stream check'},h)},handle);await received
    if(!midstream){release();await page.evaluate(()=>window.finished);await expect.poll(()=>bubble.evaluate(async()=>(await window.bubble.state()).sessions[0].status)).toBe('active')}
    expect(await page.locator('.conversation').allTextContents()).not.toEqual(expect.arrayContaining([expect.stringContaining('chunk0;')]))
    await bubble.locator('.orb').click();await bubble.getByRole('button',{name:'Return to Studio'}).click()
    const expected=Array.from({length:64},(_,i)=>`chunk${i};`).join('');await expect(page.locator('.conversation')).toContainText(expected)
    release();await expect(page.locator('.conversation')).toContainText(expected+'final-sentinel')
    expect((await page.locator('.conversation').innerText()).split('chunk0;')).toHaveLength(2)
  }finally{release();if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{})}await fixture.dispose()}
})
