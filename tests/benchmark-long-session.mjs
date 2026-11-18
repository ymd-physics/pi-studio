// Offline mixed native-session benchmark. Build first: npm run build
// BENCH_LABEL=before BENCH_RESULT=test-results/long-before.json node tests/benchmark-long-session.mjs
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'
import { _electron as electron } from '@playwright/test'
import { discoverPi } from '../src/main/minimal/runtime.ts'
import { createFixture } from './fixture.mjs'

const pairs = 200, imageCount = 24, tools = 80, chunks = 300
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = data => createHash('sha256').update(data).digest('hex')
const pngChunk = (name, data) => {
  const type = Buffer.from(name), length = Buffer.alloc(4), crc = Buffer.alloc(4)
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type, data])))
  return Buffer.concat([length, type, data, crc])
}
function image() {
  const width = 900, height = 900, raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * (width * 3 + 1) + 1 + x * 3
    raw[p] = (x + y) % 256; raw[p + 1] = (x * 3 + y) % 256; raw[p + 2] = (x + y * 5) % 256
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}
const png = image()
if (process.argv[2] === '--seed') {
  const { SessionManager } = await import(pathToFileURL(process.argv[3]).href)
  const workspace = process.argv[4], paths = [], contentHash = createHash('sha256')
  for (let s = 0; s < 3; s++) {
    const manager = SessionManager.create(workspace)
    manager.appendSessionInfo(`Long bench ${s}`)
    contentHash.update(JSON.stringify({ name: `Long bench ${s}` }) + '\n')
    const append = message => { contentHash.update(JSON.stringify(message) + '\n'); manager.appendMessage(message) }
    for (let i = 0; i < pairs; i++) {
      const content = [{ type: 'text', text: `SESSION_${s}_USER_${i}: Explain the design and preserve the results.` }]
      if (i >= pairs - imageCount) content.push({ type: 'image', mimeType: 'image/png', data: png.toString('base64') })
      append({ role: 'user', content, timestamp: 100000 + i * 3 })
      const blocks = [{ type: 'text', text: `SESSION_${s}_ANSWER_${i}: A detailed explanation with code and mathematics.\n\n\`\`\`html\n<div>HISTORY_HTML_${s}_${i}</div>\n\`\`\`\n\n` + 'Evidence and analysis. '.repeat(20) }]
      if (i < tools) blocks.push({ type: 'toolCall', id: `tool-${s}-${i}`, name: 'read', arguments: { path: `file-${i}.txt` } })
      append({ role: 'assistant', content: blocks, api: 'openai-completions', provider: 'desktop-test', model: 'test-model', usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: i < tools ? 'toolUse' : 'stop', timestamp: 100001 + i * 3 })
      if (i < tools) append({ role: 'toolResult', toolCallId: `tool-${s}-${i}`, toolName: 'read', content: [{ type: 'text', text: `OUTPUT_${s}_${i} ` + (i % 2 ? 'diagnostic line\n' : 'source content\n').repeat(100) }], isError: false, timestamp: 100002 + i * 3 })
    }
    paths.push(manager.getSessionFile())
  }
  process.stdout.write(JSON.stringify({ paths, contentSha256: contentHash.digest('hex') }))
  process.exit(0)
}
assert(!process.env.PI_CODING_AGENT_SESSION_DIR, 'Unset PI_CODING_AGENT_SESSION_DIR')
const installation = await discoverPi(), fixture = await createFixture()
const label = process.env.BENCH_LABEL || 'baseline', resultPath = process.env.BENCH_RESULT || 'test-results/long-session.json'
const code = Array.from({ length: chunks }, (_, i) => `const item_${String(i).padStart(4, '0')} = '<div>STREAM_HTML_${String(i).padStart(4, '0')}</div>'; // stable code line\n`)
const answer = '### Offline long code\n\n```html\n' + code.join('') + '```\nSTREAM_COMPLETE'
let app, timer, sampling = false, requests = 0, serverError, providerEnd = false, switchesDone = false, requestBytes = 0, requestImages = 0
const rss = []
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(++requests, 1, 'Unexpected extra model request')
    const body = []; for await (const part of req) body.push(part)
    const raw = Buffer.concat(body), parsed = JSON.parse(raw.toString())
    requestBytes = raw.length
    requestImages = (parsed.messages || []).flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'image_url').length
    assert(requestImages >= imageCount, 'Expected image inputs in the actual provider request')
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders()
    const emit = (delta, finish_reason = null, usage = false) => res.write('data: ' + JSON.stringify({ id: 'long-bench', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: usage ? [] : [{ index: 0, delta, finish_reason }], ...(usage ? { usage: { prompt_tokens: 100, completion_tokens: chunks, total_tokens: 100 + chunks } } : {}) }) + '\n\n')
    emit({ role: 'assistant', content: '### Offline long code\n\n```html\n' })
    for (const line of code) { emit({ content: line }); await sleep(30) }
    while (!switchesDone && !res.destroyed) await sleep(20)
    if (res.destroyed) return
    emit({ content: '```\nSTREAM_COMPLETE' }); emit({}, 'stop'); emit({}, null, true)
    providerEnd = true; res.end('data: [DONE]\n\n')
  } catch (error) { serverError = String(error); res.destroy() }
})
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const modelsPath = join(fixture.agentDir, 'models.json'), settingsPath = join(fixture.agentDir, 'settings.json')
  const models = JSON.parse(await readFile(modelsPath)), settings = JSON.parse(await readFile(settingsPath))
  models.providers['desktop-test'].baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  for (const model of models.providers['desktop-test'].models) { model.input = ['text', 'image']; model.contextWindow = 2000000 }
  settings.compaction.enabled = false
  await writeFile(modelsPath, JSON.stringify(models)); await writeFile(settingsPath, JSON.stringify(settings))
  const seeded = await promisify(execFile)(installation.node, [fileURLToPath(import.meta.url), '--seed', installation.sdk, fixture.workspace], { env: fixture.env, maxBuffer: 1024 * 1024 })
  const { paths, contentSha256 } = JSON.parse(seeded.stdout)
  const files = await Promise.all(paths.map(path => readFile(path)))
  assert(files.every(file => file.length < 24 * 1024 * 1024), 'Seed history exceeds safe RPC size')
  const prefsPath = join(fixture.dataDir, 'preferences.json'), prefs = JSON.parse(await readFile(prefsPath))
  prefs.activeSession = paths[0]; await writeFile(prefsPath, JSON.stringify(prefs))
  const start = performance.now()
  app = await electron.launch({ args: ['.'], env: { ...fixture.env, PI_DESKTOP_CLI: installation.cli, PI_DESKTOP_NODE: installation.node } })
  const pid = app.process().pid, page = await app.firstWindow()
  const ps = promisify(execFile)
  const sample = async () => {
    if (sampling) return; sampling = true
    try {
      const { stdout } = await ps('ps', ['-axo', 'pid=,ppid=,rss='])
      const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)), owned = new Set([pid])
      let changed = true; while (changed) { changed = false; for (const [id, parent] of rows) if (owned.has(parent) && !owned.has(id)) { owned.add(id); changed = true } }
      rss.push({ atMs: performance.now() - start, kib: rows.filter(([id]) => owned.has(id)).reduce((sum, row) => sum + row[2], 0), processes: owned.size })
    } finally { sampling = false }
  }
  await sample(); timer = setInterval(() => { sample().catch(() => {}) }, 250)
  await page.getByRole('textbox', { name: 'Message Pi' }).waitFor({ timeout: 120000 })
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable')
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
  const before = await metrics()
  await page.evaluate(() => {
    window.longBench = { frames: [], long: [], settled: false, text: '', supportedEntryTypes: PerformanceObserver.supportedEntryTypes || [] }
    let last = performance.now(); const tick = now => { window.longBench.frames.push(now - last); last = now; if (!window.longBench.done) requestAnimationFrame(tick) }; requestAnimationFrame(tick)
    if (window.longBench.supportedEntryTypes.includes('longtask')) {
      window.longBench.observer = new PerformanceObserver(list => window.longBench.long.push(...list.getEntries().map(e => e.duration)))
      window.longBench.observer.observe({ type: 'longtask' })
    }
    window.desktop.onEvent(event => { if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message.content?.some(b => b.text?.includes('STREAM_COMPLETE'))) window.longBench.text = event.message.content.filter(b => b.type === 'text').map(b => b.text).join(''); if (event.type === 'agent_settled') window.longBench.settled = true })
  })
  const ready = async (s) => {
    await page.waitForFunction(s => [...document.querySelectorAll('.session-view')].some(v => v.offsetParent && v.textContent.includes(`SESSION_${s}_ANSWER_199`)), s, { timeout: 120000 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    return page.locator('.session-view:visible').getAttribute('data-session-handle')
  }
  const validateCold = async (s, handle) => {
    const snapshot = await page.evaluate(() => window.desktop.snapshot())
    assert.equal(snapshot.state.sessionFile, paths[s]); assert.equal(snapshot.handle, handle)
    assert.equal(snapshot.messages.filter(m => m.role === 'toolResult').length, tools)
    assert.equal(snapshot.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'image').length, imageCount)
  }
  const firstHandle = await ready(0); const cold = [{ session: 0, ms: performance.now() - start }]
  await validateCold(0, firstHandle)
  const switching = []; let handlesByPath
  const select = async (s, kind) => {
    const t = performance.now(); await page.locator('.session-link').filter({ hasText: `Long bench ${s}` }).click(); const handle = await ready(s)
    const ms = performance.now() - t
    if (kind === 'cold-open') await validateCold(s, handle)
    else assert.equal(handle, handlesByPath.get(paths[s]), `Selected handle does not match session ${s}`)
    switching.push({ session: s, kind, ms })
  }
  for (const s of [1, 2]) { await select(s, 'cold-open'); cold.push(switching.at(-1)) }
  const running = await page.evaluate(() => window.desktop.runningSessions())
  handlesByPath = new Map(running.map(({ path, handle }) => [path, handle]))
  assert.equal(handlesByPath.size, 3); for (const path of paths) assert(handlesByPath.has(path))
  assert.equal(handlesByPath.get(paths[0]), firstHandle)
  for (const s of [0, 1, 2, 0]) await select(s, 'warm')
  const input = page.getByRole('textbox', { name: 'Message Pi' }); await input.fill('Produce the offline long code response.'); await input.press('Enter')
  await page.waitForFunction(() => document.querySelector('.session-view:not([hidden])')?.textContent.includes('STREAM_HTML_0000'), null, { timeout: 120000 })
  for (const s of [1, 2, 0, 1, 0]) { assert(!providerEnd, 'Stream finished before background switch'); await select(s, 'streaming') }
  switchesDone = true
  await page.waitForFunction(() => window.longBench.settled && window.longBench.text, null, { timeout: 120000 })
  assert.equal(await page.evaluate(() => window.longBench.text), answer); assert.equal(requests, 1); assert(!serverError, serverError)
  await page.getByText('STREAM_COMPLETE', { exact: false }).first().waitFor({ timeout: 120000 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const snapshotStart = performance.now(), snapshot = await page.evaluate(() => window.desktop.snapshot()), snapshotMs = performance.now() - snapshotStart
  const serialized = JSON.stringify(snapshot); assert(serialized.includes('STREAM_HTML_0299') && serialized.includes('HISTORY_HTML_0_199'))
  assert(serialized.includes('STREAM_COMPLETE')); assert(Buffer.byteLength(serialized) < 32 * 1024 * 1024)
  const frame = page.locator('.session-view:visible .image-frame').first()
  await frame.scrollIntoViewIfNeeded(); await frame.locator('img').waitFor({ timeout: 120000 })
  await page.waitForFunction(() => [...document.querySelectorAll('.session-view .image-frame img')].some(img => img.complete && img.naturalWidth), null, { timeout: 120000 })
  const thumbnails = await page.evaluate(() => [...document.querySelectorAll('.session-view .image-frame img')].filter(img => { const r = img.getBoundingClientRect(); return img.complete && img.naturalWidth && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth }).map(img => ({ width: img.naturalWidth, height: img.naturalHeight, encodedBytes: img.src.startsWith('data:') ? Math.floor(img.src.split(',')[1].length * 3 / 4) - (img.src.endsWith('==') ? 2 : img.src.endsWith('=') ? 1 : 0) : null })))
  assert(thumbnails.length > 0, 'Expected a loaded visible thumbnail')
  const stats = await page.evaluate(() => {
    const bench = window.longBench; bench.done = true
    if (bench.observer) { bench.long.push(...bench.observer.takeRecords().map(e => e.duration)); bench.observer.disconnect() }
    return { frames: bench.frames, long: bench.long, supportedEntryTypes: bench.supportedEntryTypes, nodes: document.querySelectorAll('*').length }
  })
  const after = await metrics()
  await sample(); const sorted = [...stats.frames].sort((a, b) => a - b)
  const versions = await app.evaluate(({ app }) => ({ electron: process.versions.electron, chrome: process.versions.chrome, app: app.getVersion() }))
  assert.equal(fixture.requests.length, 1, 'Fixture provider must only receive its own initial seed request')
  const output = { label, provider: { requests, requestBytes, requestImages }, workload: { sessions: 3, pairsPerSession: pairs, imagesPerSession: imageCount, toolOutputsPerSession: tools, streamChunks: chunks, streamBytes: Buffer.byteLength(answer), streamSha256: hash(answer), seedContentSha256: contentSha256, pngBytes: png.length, pngSha256: hash(png), imagePattern: 'repeated identical PNG, not distinct-image cache stress', seedFileBytes: files.map(f => f.length), seedFileSha256: files.map(hash), settings, models: { ...models.providers['desktop-test'], baseUrl: 'loopback ephemeral' } }, versions: { ...versions, node: process.version, pi: installation.version }, cold, switching, snapshot: { ms: snapshotMs, bytes: Buffer.byteLength(serialized), messages: snapshot.messages.length }, renderer: { taskCpuMs: (after.TaskDuration - before.TaskDuration) * 1000, jsHeapBytes: after.JSHeapUsedSize, supportedEntryTypes: stats.supportedEntryTypes, longTasks: stats.supportedEntryTypes.includes('longtask') ? stats.long.length : null, longTaskTotalMs: stats.long.reduce((a, b) => a + b, 0), longTaskMaxMs: Math.max(0, ...stats.long), frameP95Ms: sorted[Math.floor((sorted.length - 1) * .95)], frameMaxMs: Math.max(0, ...sorted), frameSamples: sorted.length, nodes: stats.nodes }, thumbnails, rss: { intervalMs: 250, sampledMaxSumKiB: Math.max(...rss.map(x => x.kib)), samples: rss }, limitations: ['Switch readiness is selected DOM plus two requestAnimationFrame opportunities, not physical display latency.', 'RSS is a sampled sum of app descendant process RSS; shared pages are double-counted and transient peaks can be missed.', 'CDP task CPU and heap cover the renderer only; long-task and frame observations start after initial startup.', 'Raw session file hashes include SDK-generated IDs and timestamps; seedContentSha256 hashes deterministic pre-append messages and names, and streamSha256 hashes the deterministic answer.', 'All image blocks repeat the same PNG; this is not a distinct-image cache stress test.', 'Cold-open and final snapshot validations remain within renderer CPU and RSS observation; warm and streaming switches do not issue benchmark snapshots.', 'Thumbnails count loaded images in the selected DOM; lazy loading and viewport affect the sample.', 'The provider holds the final completion until all background switches finish; slower machines may exhaust the 300 data chunks before switching ends.'] }
  await mkdir(dirname(resultPath), { recursive: true }); await writeFile(resultPath, JSON.stringify(output, null, 2)); console.log(JSON.stringify({ resultPath, cold, switching, snapshot: output.snapshot, renderer: output.renderer, thumbnails, rssMaxKiB: output.rss.sampledMaxSumKiB }, null, 2))
} finally {
  clearInterval(timer)
  if (app) { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {}); await app.close().catch(() => {}) }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fixture.dispose()
}
