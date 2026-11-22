import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

test('only conversations move a workspace; pins take precedence and survive restart', async () => {
  const f = await createFixture(), other = join(f.root, 'Other'); await mkdir(other)
  const launch = () => electron.launch({args:process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'], executablePath:process.env.PI_DESKTOP_TEST_EXECUTABLE, env:f.env})
  let app
  try {
    app = await launch(); let page = await app.firstWindow()
    const btn = name => page.getByRole('button',{name,exact:true})
    const order = () => page.locator('.workspace-heading > button:first-child > span')
    await app.evaluate(({dialog}, path) => { dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]}); dialog.showMessageBox=async()=>({response:1}) }, other)
    await btn('Add workspace').click(); await expect(order()).toHaveText(['Research','Other'])
    await btn('New session in Other').click(); await page.getByRole('menuitem',{name:'New conversation',exact:true}).click()
    await expect(page.locator('.session-view:visible .breadcrumbs')).toContainText('Other')
    const editor = page.locator('.session-view:visible').getByRole('textbox',{name:'Message Pi'}); await editor.fill('A draft only'); await expect(order()).toHaveText(['Research','Other'])
    await editor.press('Enter'); await expect(order()).toHaveText(['Other','Research'])
    await page.locator('.session-link').filter({hasText:'Discuss the harmonic oscillator'}).click(); await expect(order()).toHaveText(['Other','Research'])
    await btn('Workspace information for Research').click(); await btn('Pin workspace').click(); await expect(btn('Unpin workspace')).toBeVisible(); await expect(order()).toHaveText(['Research','Other'])
    await app.close(); app=await launch(); page=await app.firstWindow(); await expect(order()).toHaveText(['Research','Other'])
    await btn('Workspace information for Research').click(); await btn('Unpin workspace').click(); await expect(order()).toHaveText(['Other','Research'])
  } finally { if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{})}await f.dispose() }
})
