import {test,expect,_electron as electron} from '@playwright/test'
import {writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createFixture} from './fixture.mjs'

test('restore a text draft, jump from a snippet, and recover a conflicting file without overwriting it', async () => {
  const f=await createFixture(), launch=()=>electron.launch({args:process.env.PI_DESKTOP_TEST_EXECUTABLE?[]:['.'],executablePath:process.env.PI_DESKTOP_TEST_EXECUTABLE,env:f.env})
  let app
  try {
    await writeFile(join(f.workspace,'paper.md'),'original')
    app=await launch(); let page=await app.firstWindow()
    const composer=()=>page.getByRole('textbox',{name:'Message Pi'}), btn=name=>page.getByRole('button',{name,exact:true})
    await composer().fill('draft before restart')
    await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1})}); await app.close()
    app=await launch(); page=await app.firstWindow(); await expect(composer()).toHaveValue('draft before restart')
    await btn('Search sessions in Research').click(); await page.getByLabel('Search session titles and messages').fill('angular frequency')
    await page.locator('.workspace-search-results button').first().click()
    await expect(page.locator('[data-find-current]')).toContainText('Angular frequency')
    await expect(composer()).toHaveValue('draft before restart')
    await btn('Toggle files').click(); await btn('paper.md').click(); await btn('Edit').click(); await page.getByLabel('File editor').fill('my version')
    await writeFile(join(f.workspace,'paper.md'),'external version'); await btn('Save').click()
    await page.getByText('Compare versions',{exact:true}).click(); await expect(page.locator('.file-conflict pre')).toHaveText(['external version','my version'])
    await btn('Save draft as…').click(); await page.getByRole('dialog',{name:'Save draft as…'}).getByRole('button',{name:'Save'}).click()
    await expect.poll(()=>readFile(join(f.workspace,'paper-draft.md'),'utf8').catch(()=>'' )).toBe('my version')
    expect(await readFile(join(f.workspace,'paper.md'),'utf8')).toBe('external version')
  } finally { if(app){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{})}await f.dispose() }
})
