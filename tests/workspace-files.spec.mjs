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
    await button('Toggle files').click();await panel.getByRole('button',{name:'nested',exact:true}).click();await button('paper.md').click();await button('Edit').click();await editor.fill('workspace draft')
    await button('Close files').click();await expect(panel).toHaveCount(0);await button('Toggle files').click();await expect(editor).toHaveValue('workspace draft')
    await create('Research');await expect(editor).toHaveValue('workspace draft');await expect(panel.getByRole('navigation',{name:'Folder path'})).toContainText('nested')
    await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});dialog.showMessageBox=async()=>({response:1,checkboxChecked:false})},other)
    await button('Add workspace').click();await create('other');await expect(panel).toHaveCount(0);await button('Toggle files').click();await panel.getByRole('button',{name:'other.txt'}).click();await expect(panel.locator('.file-preview')).toContainText('other document')
    const research=page.locator('.session-link').filter({hasText:'Discuss the harmonic oscillator'}),otherRow=page.locator('.session-link.selected');await page.getByRole('textbox',{name:'Message Pi'}).fill('/name Other check');await page.getByRole('textbox',{name:'Message Pi'}).press('Enter');await expect(otherRow).toContainText('Other check');await research.click();await expect(editor).toHaveValue('workspace draft');await button('Toggle files').click();await page.locator('.session-link').filter({hasText:'Other check'}).click();await expect(panel.locator('.file-preview')).toContainText('other document');await research.click();await expect(panel).toHaveCount(0);await button('Toggle files').click();await expect(editor).toHaveValue('workspace draft')
  }finally{if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{})}await f.dispose()}
})
