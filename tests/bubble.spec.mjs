import { test, expect, _electron as electron } from '@playwright/test'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createFixture} from './fixture.mjs'

test('bubble hides Studio, stays on top and routes the live request once',async()=>{
  const fixture=await createFixture();let app
  try{
    await writeFile(join(fixture.agentDir,'extensions/bubble.ts'),`export default function(pi){pi.registerCommand('bubble-check',{handler:async(_,ctx)=>{const yes=await ctx.ui.confirm('Allow fixture operation?', 'Only this session');ctx.ui.notify('Bubble response: '+yes,'info')}})}`)
    app=await electron.launch({args:process.env.PI_DESKTOP_TEST_EXECUTABLE?[]:['.'],executablePath:process.env.PI_DESKTOP_TEST_EXECUTABLE,env:fixture.env})
    const page=await app.firstWindow(),input=page.getByRole('textbox',{name:'Message Pi'})
    await expect(input).toBeVisible();await input.fill('preserve draft')
    const added=app.waitForEvent('window');await page.getByRole('button',{name:'Switch to desktop bubble'}).click();const bubble=await added
    await expect(bubble.locator('.orb')).toBeVisible();await expect(bubble.locator('.orb')).toHaveCSS('width','84px')
    await expect.poll(()=>app.evaluate(({BrowserWindow})=>{const wins=BrowserWindow.getAllWindows(),host=wins.find(w=>!w.webContents.getURL().includes('bubble.html')),b=wins.find(w=>w!==host);return [host?.isVisible(),b?.isVisible(),b?.isAlwaysOnTop(),b?.isVisibleOnAllWorkspaces()]})).toEqual([false,true,true,true])
    // Observe the very first mount, not just the settled screenshot: the old
    // renderer mounted the panel over the orb in the still-collapsed window.
    // The real pointer may already be resting at the persisted desktop anchor.
    await bubble.mouse.move(1,1);await bubble.keyboard.press('Escape');await expect(bubble.locator('aside')).toHaveCount(0)
    await bubble.evaluate(()=>{const probe=new MutationObserver(()=>{const panel=document.querySelector('aside');if(!panel)return;const a=panel.getBoundingClientRect(),o=document.querySelector('.orb').getBoundingClientRect();window.firstPanelClear=a.right<=o.left+1||a.left>=o.right-1;probe.disconnect()});probe.observe(document.body,{childList:true,subtree:true})})
    await bubble.locator('.orb').hover();await bubble.waitForTimeout(400);await expect(bubble.locator('aside')).toHaveCount(0)
    await bubble.locator('.orb').click();await expect(bubble.locator('aside')).toBeVisible();expect(await bubble.evaluate(()=>window.firstPanelClear)).toBe(true)
    await bubble.mouse.move(1,1);await bubble.waitForTimeout(400);await expect(bubble.locator('aside')).toBeVisible()
    // The transparent native-window gutter is outside both interactive surfaces.
    await bubble.mouse.click(1,1);await expect(bubble.locator('aside')).toHaveCount(0)
    await bubble.locator('.orb').click();await expect(bubble.locator('aside')).toBeVisible()
    await bubble.locator('.orb').click();await expect(bubble.locator('aside')).toHaveCount(0)
    await bubble.locator('.orb').click();await bubble.keyboard.press('Escape');await expect(bubble.locator('aside')).toHaveCount(0)
    // Pointer capture keeps the release attached to the moving orb; its click
    // must not toggle the panel after crossing the drag threshold.
    const orb=await bubble.locator('.orb').boundingBox()
    await bubble.mouse.move(orb.x+orb.width/2,orb.y+orb.height/2);await bubble.mouse.down()
    await bubble.mouse.move(orb.x+orb.width/2+12,orb.y+orb.height/2,{steps:3});await bubble.mouse.up()
    await expect(bubble.locator('aside')).toHaveCount(0)
    await bubble.locator('.orb').click();await expect(bubble.locator('aside')).toBeVisible()
    await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('bubble.html'))?.isFocused())).toBe(true)
    // A separate native window exercises focus loss, not a DOM blur surrogate.
    await app.evaluate(({BrowserWindow})=>{const outside=new BrowserWindow({title:'Bubble outside click test',width:200,height:200});outside.show();outside.focus()})
    await expect(bubble.locator('aside')).toHaveCount(0)
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Bubble outside click test')?.destroy())
    const handle=await page.evaluate(async()=>(await window.desktop.snapshot()).handle)
    await page.evaluate(h=>{void window.desktop.command('prompt',{message:'/bubble-check'},h)},handle)
    await bubble.locator('.orb').click();await expect(bubble.getByText('Allow fixture operation?')).toBeVisible();await bubble.getByRole('button',{name:'Confirm',exact:true}).click()
    await expect(bubble.getByText('Allow fixture operation?')).toHaveCount(0);await bubble.getByRole('button',{name:'Bubble settings'}).click();await bubble.getByRole('button',{name:'Small',exact:true}).click();await expect(bubble.locator('.orb')).toHaveCSS('width','68px');await bubble.getByRole('button',{name:'Large',exact:true}).click();await expect(bubble.locator('.orb')).toHaveCSS('width','100px');await bubble.getByRole('button',{name:'Return to Studio'}).click();await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>w.isVisible()))).toEqual([true]);await expect(input).toHaveValue('preserve draft');await expect(page.getByRole('dialog',{name:'Allow fixture operation?'})).toHaveCount(0);await expect(page.locator('.session-notice').filter({hasText:'Bubble response: true'})).toBeVisible()
  }finally{if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{})}await fixture.dispose()}
})
