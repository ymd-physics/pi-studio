// Offline end-to-end streaming diagnostic; never uses production auth/history.
// npm run build && node tests/benchmark-stream.mjs
// Optional: PI_DESKTOP_TEST_EXECUTABLE='/path/to/Pi Desktop' node tests/benchmark-stream.mjs
// This measures local overhead, NOT OpenAI generation speed. SSE chunks are not tokens.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { _electron as electron } from '@playwright/test'
import { discoverPi } from '../src/main/minimal/runtime.ts'
import { createFixture } from './fixture.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const count = 200
const marker = i => `BENCH_${String(i).padStart(4, '0')} `
const prefix = '### Streaming test\n\nAn equation $E=mc^2$.\n\n```python\nfor n in range(10):\n    print(n ** 2)\n```\n\n'.repeat(20)
const answer = prefix + Array.from({ length: count }, (_, i) => marker(i)).join('')
const quantiles = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) }
}
assert(!process.env.PI_CODING_AGENT_SESSION_DIR, 'Unset PI_CODING_AGENT_SESSION_DIR to keep benchmark history isolated')
const installation = await discoverPi()
const fixture = await createFixture()
const prefs = JSON.parse(await readFile(join(fixture.dataDir, 'preferences.json'), 'utf8'))
const seed = await readFile(prefs.activeSession)
let active, child, app
const samples = []
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const sample = active
    assert(sample && !sample.request, 'Expected exactly one provider request per sample')
    sample.request = body
    sample.requestAt = Date.now()
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.flushHeaders()
    const emit = (delta, finish_reason = null, usage) => res.write('data: ' + JSON.stringify({
      id: 'stream-benchmark', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: usage ? [] : [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    }) + '\n\n')
    await sleep(120)
    emit({ role: 'assistant', content: prefix })
    for (let i = 0; i < count; i++) {
      sample.sent[i] = Date.now()
      emit({ content: marker(i) })
      await sleep(10)
    }
    emit({}, 'stop')
    emit({}, null, { prompt_tokens: 100, completion_tokens: count, total_tokens: 100 + count })
    sample.providerEnd = Date.now()
    res.end('data: [DONE]\n\n')
  } catch (error) {
    if (active) active.serverError = String(error)
    res.destroy(error)
  }
})

function observe(event, sample) {
  const now = Date.now()
  if (event.type === 'turn_start') sample.turnAt = now
  if (event.type === 'message_update') {
    const delta = event.assistantMessageEvent?.delta
    if (typeof delta === 'string') for (const m of delta.matchAll(/BENCH_(\d{4})/g)) sample.received[+m[1]] = now
  }
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    sample.endAt = now
    sample.output = event.message.usage?.output
    assert.equal(event.message.content.filter(b => b.type === 'text').map(b => b.text).join(''), answer)
  }
  if (event.type === 'agent_settled') sample.settled = true
}

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const modelsPath = join(fixture.agentDir, 'models.json')
  const models = JSON.parse(await readFile(modelsPath, 'utf8'))
  models.providers['desktop-test'].baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await writeFile(modelsPath, JSON.stringify(models))
  // Restore the identical native-seeded history before each arm, only after its writer exits.
  for (let round = 0; round < 3; round++) {
    // Rotate order to avoid always measuring one arm under the same machine load.
    const order = ['cli', 'bridge', 'app']
    for (const mode of [...order.slice(round), ...order.slice(0, round)]) {
      await writeFile(prefs.activeSession, seed)
      // Closing a session intentionally clears the app's remembered selection.
      await writeFile(join(fixture.dataDir, 'preferences.json'), JSON.stringify(prefs))
      const sample = active = { mode, round, sent: [], received: [] }
      const env = { ...fixture.env, PI_DESKTOP_CLI: installation.cli, PI_DESKTOP_NODE: installation.node }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.PI_SESSION_ID
      delete env.PI_SESSION_FILE
      if (mode === 'app') {
        app = await electron.launch({
          args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
          executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE, env,
        })
        const page = await app.firstWindow()
        await page.getByRole('textbox', { name: 'Message Pi' }).waitFor()
        await page.evaluate(() => {
          window.streamBench = { received: [], dom: [] }
          const bench = window.streamBench
          window.desktop.onEvent(event => {
            const now = Date.now()
            if (event.type === 'turn_start') bench.turnAt = now
            const delta = event.assistantMessageEvent?.delta
            if (typeof delta === 'string') for (const m of delta.matchAll(/BENCH_(\d{4})/g)) bench.received[+m[1]] = now
            if (event.type === 'message_end' && event.message?.role === 'assistant') {
              bench.endAt = now
              bench.output = event.message.usage?.output
              bench.text = event.message.content.filter(b => b.type === 'text').map(b => b.text).join('')
            }
            if (event.type === 'agent_settled') bench.settled = true
          })
          new MutationObserver(() => {
            const now = Date.now()
            for (const m of document.querySelector('.reading-column').textContent.matchAll(/BENCH_(\d{4})/g))
              bench.dom[+m[1]] ??= now
          }).observe(document.querySelector('.reading-column'), { subtree: true, childList: true, characterData: true })
        })
        const input = page.getByRole('textbox', { name: 'Message Pi' })
        await input.fill('Run the offline streaming benchmark.')
        sample.dispatchAt = Date.now()
        await input.press('Enter')
        await page.waitForFunction(n => window.streamBench.settled && window.streamBench.dom[n - 1], count, { timeout: 30000 })
        const observed = await page.evaluate(() => window.streamBench)
        assert.equal(observed.text, answer)
        delete observed.text
        Object.assign(sample, observed)
        sample.statistics = await page.getByLabel('Response statistics').innerText()
        // Use the normal isolated-session shutdown before destroying its test window.
        const handles = await page.evaluate(() => window.desktop.runningSessions())
        for (const { handle } of handles) await page.evaluate(h => window.desktop.closeSession(h), handle)
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy()))
        await app.close()
        app = undefined
      } else {
        let ready = false, stderr = ''
        const args = mode === 'cli'
          ? [installation.cli, '--mode', 'rpc', '--approve', '--session', prefs.activeSession]
          : [resolve('resources/desktop-rpc.mjs'), installation.sdk, prefs.activeSession]
        child = spawn(installation.node, args, { cwd: fixture.workspace, env, stdio: 'pipe' })
        child.stderr.on('data', data => { stderr += data })
        const lines = createInterface({ input: child.stdout })
        lines.on('line', line => {
          try {
            const event = JSON.parse(line)
            if (event.type === 'response' && event.id === 'ready') {
              assert.equal(event.success, true)
              ready = true
            }
            observe(event, sample)
          } catch (error) {
            sample.observerError = error
          }
        })
        child.stdin.write(JSON.stringify({ type: 'get_state', id: 'ready' }) + '\n')
        const deadline = Date.now() + 30000
        while (!ready && !sample.observerError && Date.now() < deadline && child.exitCode === null) await sleep(10)
        if (sample.observerError) throw sample.observerError
        assert(ready, `Native startup failed: ${stderr}`)
        sample.dispatchAt = Date.now()
        child.stdin.write(JSON.stringify({ type: 'prompt', id: 'prompt', message: 'Run the offline streaming benchmark.' }) + '\n')
        while (!sample.settled && !sample.observerError && Date.now() < deadline && child.exitCode === null) await sleep(10)
        if (sample.observerError) throw sample.observerError
        assert(sample.settled, `Native run did not settle: ${stderr}`)
        const closed = once(child, 'close')
        child.kill('SIGTERM')
        await closed
        child = undefined
        lines.close()
      }
      assert(!sample.serverError, sample.serverError)
      assert.equal(sample.output, count)
      assert.equal(sample.received.filter(Number.isFinite).length, count, 'Lost streamed markers')
      const lag = sample.sent.map((sent, i) => sample.received[i] - sent)
      const result = {
        mode, round, requestBytes: Buffer.byteLength(JSON.stringify(sample.request)),
        requestHash: createHash('sha256').update(JSON.stringify(sample.request)).digest('hex'),
        dispatchToRequestMs: sample.requestAt - sample.dispatchAt,
        producerSpanMs: sample.sent.at(-1) - sample.sent[0],
        consumerSpanMs: sample.received.at(-1) - sample.received[0],
        deliveryLagMs: quantiles(lag), endLagMs: sample.endAt - sample.providerEnd,
        measuredTokPerSec: +(count / ((sample.endAt - sample.turnAt) / 1000)).toFixed(2),
        ...(sample.dom ? { domLagMs: quantiles(sample.sent.map((sent, i) => sample.dom[i] - sent)), statistics: sample.statistics } : {}),
      }
      if (sample.statistics) {
        const displayedRate = Number(/([\d.]+) tok\/s/.exec(sample.statistics)?.[1])
        assert(Math.abs(displayedRate - result.measuredTokPerSec) < .2, 'Displayed rate differs from observed event timing')
      }
      samples.push({ result, request: sample.request })
      console.log(JSON.stringify(result))
    }
  }
  for (const sample of samples) assert.deepEqual(sample.request, samples[0].request, 'Provider payload differs between runs')
  console.log(JSON.stringify({ payloadsIdentical: true, samples: samples.length, chunksPerSample: count }))
} finally {
  if (child) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed }
  if (app) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {})
    await app.close().catch(() => {})
  }
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await fixture.dispose()
}
