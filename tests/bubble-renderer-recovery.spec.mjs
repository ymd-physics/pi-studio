import {test, expect, _electron as electron} from '@playwright/test'
import {createFixture} from './fixture.mjs'

test('recovers a crashed hidden Studio renderer without relaunching the app',async()=>{
  const f=await createFixture(); let app
  try {
    app=await electron.launch({args:process.env.PI_DESKTOP_TEST_EXECUTABLE?[]:['.'],executablePath:process.env.PI_DESKTOP_TEST_EXECUTABLE,env:f.env})
    const page=await app.firstWindow()
    await expect(page.getByRole('textbox',{name:'Message Pi'})).toBeVisible()
    const handle=await page.evaluate(async()=>(await window.desktop.snapshot()).handle)
    const opened=app.waitForEvent('window'); await page.getByRole('button',{name:'Switch to desktop bubble'}).click(); await opened
    await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>!w.isVisible() && w.webContents.getURL().endsWith('index.html')))).toBe(true)
    await app.evaluate(({BrowserWindow,dialog})=>{
      dialog.showMessageBox=async()=>({response:0})
      BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html')).webContents.forcefullyCrashRenderer()
    })
    await expect.poll(()=>app.evaluate(async({BrowserWindow})=>{
      const windows=BrowserWindow.getAllWindows(), w=windows[0]
      if(windows.length!==1 || !w.isVisible() || w.webContents.isCrashed() || w.webContents.isLoading()) return null
      return w.webContents.executeJavaScript(`document.querySelector('textarea[aria-label="Message Pi"]') && window.desktop.snapshot().then(s=>s.handle)`).catch(()=>null)
    }),{timeout:10000}).toBe(handle)
  } finally { if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{})} await f.dispose() }
})
