import {test,expect,_electron as electron} from '@playwright/test'
import {mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createFixture} from './fixture.mjs'

test('files follow the workspace, not the session or the visible panel',async()=>{
  const f=await createFixture();let app
  try{
    const other=join(f.root,'other');await mkdir(other);await mkdir(join(f.workspace,'nested'))
    await writeFile(join(f.workspace,'nested','paper.md'),'original');await writeFile(join(other,'other.txt'),'other document')
    app=await electron.launch({args:process.env.PI_DESKTOP_TEST_EXECUTABLE?[]:['.'],executablePath:process.env.PI_DESKTOP_TEST_EXECUTABLE,env:f.env})
    const page=await app.firstWindow(),button=name=>page.getByRole('button',{name,exact:true}),panel=page.getByRole('complementary',{name:'Workspace files'}),editor=page.getByRole('textbox',{name:'File editor'})
    const create=async(ws)=>{await button('New session in '+ws).click();await page.getByRole('menuitem',{name:'New conversation',exact:true}).click();await expect(page.locator('.session-view:visible .breadcrumbs')).toContainText(ws)}
    const png = await app.evaluate(({nativeImage}) => nativeImage.createFromBitmap(Buffer.alloc(8*6*4,255),{width:8,height:6}).toPNG().toString('base64'))
    await writeFile(join(f.workspace,'figure.PNG'),Buffer.from(png,'base64'))
    const jpg = await app.evaluate(({nativeImage}) => nativeImage.createFromBitmap(Buffer.alloc(13*7*4,255),{width:13,height:7}).toJPEG(85).toString('base64'))
    const jpgNames = ['photo.jpg','upper.JPG','other.jpeg']
    for (const name of jpgNames) await writeFile(join(f.workspace,name), Buffer.from(jpg,'base64'))
    const pdf = await app.evaluate(async ({BrowserWindow}) => {
      const w = new BrowserWindow({show:false}); try {
        await w.loadURL('data:text/html,<body>First page<div style="break-before:page">Second page</div></body>')
        return (await w.webContents.printToPDF({})).toString('base64')
      } finally {w.destroy()}
    })
    await writeFile(join(f.workspace,'pages.PDF'),Buffer.from(pdf,'base64'))
    await button('Toggle files').click();
    await button('notes.md').click({button:'right'}); await page.getByRole('menuitem',{name:'Compress to ZIP'}).click()
    await button('notes.md.zip').click(); await expect(panel.getByRole('status')).toHaveText('Pi Studio can’t preview this file format.'); await expect(panel.getByRole('button',{name:'Open with default application'})).toBeVisible(); await expect(panel.getByRole('alert')).toHaveCount(0)
    await button('notes.md.zip').click({button:'right'}); await expect(page.getByRole('menuitem').filter({hasNot:page.locator('svg')})).toHaveCount(0); await page.getByRole('menuitem',{name:'Extract ZIP here'}).click()
    await expect(button('notes.md (2)')).toBeVisible()
    for (const name of jpgNames) {
      await button(name).click()
      await expect.poll(() => panel.getByRole('img',{name,exact:true}).evaluate(img => img.naturalWidth)).toBe(13)
    }
    await button('pages.PDF').click(); await expect(panel.getByText('1 / 2')).toBeVisible(); await expect(panel.getByLabel('PDF preview')).toBeVisible()
    await expect(panel.getByRole('button',{name:'Edit',exact:true})).toHaveCount(0)
    const pageInk = () => panel.locator('canvas').evaluate(c=>{const b=c.getContext('2d').getImageData(0,0,c.width,c.height).data; return b.some((v,i)=>i%4===0 && v<120 && b[i+3]===255)})
    await expect.poll(pageInk).toBe(true); await button('Next page').click(); await expect(panel.getByText('2 / 2')).toBeVisible(); await expect.poll(pageInk).toBe(true)
    await button('figure.PNG').click()
    const figure = panel.getByRole('img',{name:'figure.PNG'})
    await expect.poll(() => figure.evaluate(img=>img.naturalWidth)).toBe(8)
    await expect(panel.getByRole('button',{name:'Edit',exact:true})).toHaveCount(0)
    await figure.click(); const viewer=page.getByRole('dialog',{name:'Image: figure.PNG'});await expect(viewer).toBeVisible();await viewer.getByRole('button',{name:'Close image'}).click();await expect(viewer).toHaveCount(0)
    await panel.getByRole('button',{name:'nested',exact:true}).click();await button('paper.md').click();await button('Edit').click();await editor.fill('workspace draft')
    await button('Close files').click();await expect(panel).toHaveCount(0);await button('Toggle files').click();await expect(editor).toHaveValue('workspace draft')
    await create('Research');await expect(editor).toHaveValue('workspace draft');await expect(panel.getByRole('navigation',{name:'Folder path'})).toContainText('nested')
    await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});dialog.showMessageBox=async()=>({response:1,checkboxChecked:false})},other)
    await button('Add workspace').click();await create('other');await expect(panel).toHaveCount(0);await button('Toggle files').click();await panel.getByRole('button',{name:'other.txt'}).click();await expect(panel.locator('.file-preview')).toContainText('other document')
    const research=page.locator('.session-link').filter({hasText:'Discuss the harmonic oscillator'}),otherRow=page.locator('.session-link.selected');await page.getByRole('textbox',{name:'Message Pi'}).fill('/name Other check');await page.getByRole('textbox',{name:'Message Pi'}).press('Enter');await expect(otherRow).toContainText('Other check');await research.click();await expect(editor).toHaveValue('workspace draft');await button('Toggle files').click();await page.locator('.session-link').filter({hasText:'Other check'}).click();await expect(panel.locator('.file-preview')).toContainText('other document');await research.click();await expect(panel).toHaveCount(0);await button('Toggle files').click();await expect(editor).toHaveValue('workspace draft')
  }finally{if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{})}await f.dispose()}
})
