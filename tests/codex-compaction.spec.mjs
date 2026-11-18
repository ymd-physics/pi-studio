import { test, expect, _electron as electron } from '@playwright/test'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFixture } from './fixture.mjs'

for (const existingPlugin of [false, true])
  test(`OpenAI Codex compaction: ${existingPlugin ? 'existing plugin, no duplicate request' : 'bundled default'}, checkpoint persistence and replay`, async () => {
    test.skip(
      existingPlugin && !process.env.PI_DESKTOP_TEST_CODEX_PLUGIN,
      'Set PI_DESKTOP_TEST_CODEX_PLUGIN to the reviewed plugin index.ts',
    )
    const fixture = await createFixture()
    let app
    try {
      // No credentials or Internet: this extension intercepts the exact remote compaction
      // request and aborts normal provider requests after inspecting checkpoint replay.
      await writeFile(
        join(fixture.agentDir, 'extensions/offline-codex.ts'),
        `
      const nativeFetch = globalThis.fetch;
      export default function(pi) {
        const token='x.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'test-account'}})).toString('base64url')+'.x';
        pi.registerProvider('openai-codex', {baseUrl:'https://chatgpt.com/backend-api', api:'openai-codex-responses', apiKey:token,
          models:[{id:'offline-codex',name:'Offline Codex',reasoning:true,input:['text'],contextWindow:200000,maxTokens:2000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
        let count=0;
        globalThis.fetch=async (url,options)=> {
          if (String(url).startsWith('http://127.0.0.1:')) return nativeFetch(url,options);
          if (String(url)!=='https://chatgpt.com/backend-api/codex/responses') throw new Error('Offline fixture blocked network');
          const body=JSON.parse(options.body);
          if(body.input.at(-1)?.type!=='compaction_trigger') throw new Error('Expected remote compaction trigger');
          if(++count>1) throw new Error('Duplicate compaction request');
          await new Promise(resolve=>setTimeout(resolve,700));
          return new Response('data: '+JSON.stringify({type:'response.output_item.done',item:{type:'compaction',encrypted_content:'offline-encrypted-checkpoint'}})+'\\n\\ndata: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:6000,output_tokens:50}}})+'\\n\\n',{headers:{'content-type':'text/event-stream'}});
        };
        pi.on('before_provider_request',(event,ctx)=> {
          if(ctx.model?.provider!=='openai-codex') return;
          const replay=event.payload.input?.filter(item=>item.type==='compaction');
          if(replay?.length!==1) throw new Error('Missing or duplicated checkpoint');
          ctx.ui.notify('Verified native Codex checkpoint replay','info');
          ctx.abort();
        });
      }
    `,
      )
      if (existingPlugin) {
        const settingsPath = join(fixture.agentDir, 'settings.json')
        const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
        settings.extensions = [...(settings.extensions || []), process.env.PI_DESKTOP_TEST_CODEX_PLUGIN]
        await writeFile(settingsPath, JSON.stringify(settings))
      }
      app = await electron.launch({
        args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
        executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
        env: fixture.env,
      })
      const page = await app.firstWindow(),
        input = page.getByRole('textbox', { name: 'Message Pi' })
      await expect(input).toBeVisible()
      await input.fill('More context before compaction')
      await input.press('Enter')
      await expect.poll(() => fixture.requests.length).toBe(2)
      await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0)
      await page.getByLabel('Model', { exact: true }).selectOption('openai-codex/offline-codex')
      await expect(page.getByLabel('Model', { exact: true })).toBeEnabled()
      await input.fill('/compact')
      await input.press('Enter')
      await expect(page.locator('.compaction-notice.running')).toContainText('OpenAI Codex')
      await expect(page.locator('.compaction-notice.running')).toContainText('Compacting')
      if (existingPlugin) await expect(page.locator('.compaction-model')).toHaveText('Model: OpenAI Codex')
      await expect(page.locator('.compaction-notice.complete')).toContainText(
        'OpenAI Codex · Context compacted',
      )
      await expect(page.locator('.compaction-notice.complete')).toContainText('Encrypted checkpoint saved')
      const sessions = await page.evaluate(() => window.desktop.runningSessions())
      const file = sessions[0].path
      const entries = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse)
      expect(entries.filter((e) => e.type === 'compaction')).toHaveLength(1)
      expect(
        entries.find((e) => e.type === 'compaction').details.replacementHistory.at(-1).encrypted_content,
      ).toBe('offline-encrypted-checkpoint')
      await page.locator('.compaction-notice.complete').scrollIntoViewIfNeeded()
      await page.screenshot({ path: `test-results/codex-compaction${existingPlugin ? '-plugin' : ''}.png` })
      await input.fill('/reload')
      await input.press('Enter')
      await expect(page.getByText('Pi resources reloaded. Session history preserved.')).toBeVisible()
      await input.fill('Check restored checkpoint')
      await input.press('Enter')
      await expect(page.getByText('Verified native Codex checkpoint replay')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0)
    } finally {
      if (app) {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
        await app.close()
      }
      await fixture.dispose()
    }
  })
