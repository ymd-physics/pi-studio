// Repeatable UI workload, not a provider-speed benchmark. No real auth/history.
// npm run build && node tests/benchmark-ui.mjs
import { _electron as electron } from '@playwright/test'
import { createFixture } from './fixture.mjs'
const fixture = await createFixture()
let app
try {
  app = await electron.launch({ args: ['.'], env: fixture.env })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: 'Message Pi' }).waitFor()
  const handle = (await page.evaluate(() => window.desktop.runningSessions()))[0].handle
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const measure = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name,m.value]))
  const before = await measure()
  await page.evaluate(() => {
    window.bench = { frames: [], long: [], mutations: 0, done: false }
    let last = performance.now()
    const frame = now => { window.bench.frames.push(now-last);last=now;if(!window.bench.done)requestAnimationFrame(frame) }
    requestAnimationFrame(frame)
    new PerformanceObserver(list => { window.bench.long.push(...list.getEntries().map(e=>e.duration)) }).observe({type:'longtask',buffered:false})
    new MutationObserver(() => window.bench.mutations++).observe(document.querySelector('.reading-column'), {subtree:true,childList:true,characterData:true})
  })
  const start = Date.now()
  await app.evaluate(async ({ BrowserWindow }, {handle}) => {
    const win = BrowserWindow.getAllWindows()[0]
    const send = record => win.webContents.send('pi:event', {...record,desktopSession:handle})
    send({type:'agent_start'})
    const assistant = (timestamp,content) => ({role:'assistant',timestamp,content,stopReason:'stop',usage:{input:100,output:20,totalTokens:120}})
    for(let i=0;i<60;i++) {
      const message = assistant(100+i,[{type:'text',text:`### Note ${i}\n\nAn equation $E=mc^2$ and code:\n\n\`\`\`python\nfor n in range(10):\n    print(n ** 2)\n\`\`\``}])
      send({type:'message_start',message});send({type:'message_end',message})
    }
    const calls = Array.from({length:120},(_,i)=>({type:'toolCall',id:`bench-${i}`,name:'read',arguments:{path:`file-${i}.ts`}}))
    const tools = assistant(200,calls)
    send({type:'message_start',message:tools});send({type:'message_end',message:tools})
    for(let i=0;i<120;i++) send({type:'message_end',message:{role:'toolResult',timestamp:300+i,toolCallId:`bench-${i}`,toolName:'read',content:[{type:'text',text:'output '.repeat(2048)}]}})
    send({type:'turn_start'})
    const prefix = '### Live explanation\n\nFor $E=mc^2$, consider this example:\n\n```python\nfor n in range(10):\n    print(n ** 2)\n```\n\n'.repeat(20)
    send({type:'message_start',message:{...assistant(500,[{type:'text',text:prefix}]),stopReason:'pending'}})
    for(let i=0;i<200;i++) {
      send({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'stream-token '}})
      await new Promise(resolve=>setTimeout(resolve,5))
    }
    send({type:'message_end',message:assistant(500,[{type:'text',text:prefix+'stream-token '.repeat(200)+'BENCH-DONE'}])})
  }, {handle})
  await page.getByText(/BENCH-DONE/).waitFor({timeout:120000})
  // Wait for actual highlighting/paint, not an arbitrary model completion clock.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  const after = await measure()
  const stats = await page.evaluate(() => {window.bench.done=true;return {...window.bench,nodes:document.querySelectorAll('*').length,toolRows:document.querySelectorAll('.tool-row').length}})
  const percentile = (values,p) => [...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*p)] || 0
  console.log(JSON.stringify({elapsedMs:Date.now()-start,frameP95Ms:percentile(stats.frames,.95),maxFrameMs:Math.max(...stats.frames),longTasks:stats.long.length,longTaskMs:stats.long.reduce((a,b)=>a+b,0),domNodes:stats.nodes,toolRows:stats.toolRows,mutationBatches:stats.mutations,taskCpuMs:(after.TaskDuration-before.TaskDuration)*1000,heapMiB:after.JSHeapUsedSize/1024/1024},null,2))
} finally {
  if(app) {await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy()));await app.close()}
  await fixture.dispose()
}
