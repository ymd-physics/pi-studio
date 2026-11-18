// Offline integration against an explicitly selected installed SDK, never its auth/session data.
// PI_CORE_ROOT=/absolute/pi-coding-agent node --test tests/codex-compaction.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { compactionPolicyOverride } from '../resources/desktop-rpc.mjs'
const core = process.env.PI_CORE_ROOT
if (!core) throw new Error('Set PI_CORE_ROOT to a reviewed installed Pi SDK')
const require = createRequire(join(core, 'package.json'))
const { createJiti } = require('jiti')
const jiti = createJiti(import.meta.url, {
  alias: {
    '@earendil-works/pi-coding-agent': join(core, 'dist/index.js'),
    '@earendil-works/pi-ai': resolve(core, '../pi-ai/dist/index.js'),
  },
})
const extension = await jiti.import(resolve('resources/codex-compaction/index.ts'))
const helper = await jiti.import(resolve('resources/codex-compaction/native-compaction.ts'))
const { SessionManager } = await import(pathToFileURL(join(core, 'dist/index.js')))
const model = {
  provider: 'openai-codex',
  api: 'openai-codex-responses',
  id: 'gpt-5.4',
  baseUrl: 'https://chatgpt.com/backend-api',
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
const key = Symbol.for('pi-desktop.compaction-policy')
const token = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url')}.x`
const wireTool = { type: 'function', name: 'read', parameters: { type: 'object' }, strict: true }
function sse() {
  return new Response(
    'data: ' +
      JSON.stringify({
        type: 'response.output_item.done',
        item: { type: 'compaction', encrypted_content: 'offline-checkpoint' },
      }) +
      '\n\ndata: ' +
      JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 800, output_tokens: 40, total_tokens: 840 } },
      }) +
      '\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
function harness() {
  globalThis[key] = { externalCompaction: false, externalReplay: false }
  const handlers = new Map(),
    notices = [],
    statuses = []
  let aborted = false
  const sessionManager = SessionManager.inMemory('/tmp/codex-compaction-test')
  sessionManager.appendMessage({ role: 'user', content: 'Preserve the research goal.', timestamp: 1 })
  sessionManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'Initial answer' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: model.cost },
    stopReason: 'stop',
    timestamp: 2,
  })
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    getAllTools: () => [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }],
    getActiveTools: () => ['read'],
  }
  const ctx = {
    model,
    sessionManager,
    getSystemPrompt: () => 'You are Pi.',
    abort: () => {
      aborted = true
    },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) },
    ui: {
      notify: (message, type) => notices.push({ message, type }),
      setStatus: (name, text) => statuses.push({ name, text }),
    },
  }
  extension.default(pi)
  const compact = (signal = new AbortController().signal) =>
    handlers.get('session_before_compact')(
      {
        branchEntries: sessionManager.getBranch(),
        preparation: { firstKeptEntryId: sessionManager.getBranch()[0].id, tokensBefore: 120000 },
        reason: 'manual',
        signal,
      },
      ctx,
    )
  return {
    handlers,
    ctx,
    compact,
    notices,
    statuses,
    get aborted() {
      return aborted
    },
  }
}

test('exact version/API/endpoint admission; no generic OpenAI widening', () => {
  for (const version of ['1.4.0', '1.5.0', 'v1.4.1', '2.0.0'])
    assert.equal(extension.supportedHost(version), true)
  for (const version of ['1.3.99', '0.99.0', '1.4.0-beta.1', 'unknown'])
    assert.equal(extension.supportedHost(version), false)
  assert.equal(extension.supportedModel(model), true)
  for (const other of [
    { ...model, provider: 'openai', api: 'openai-responses' },
    { ...model, baseUrl: 'https://evil.test/backend-api' },
    { ...model, baseUrl: 'https://chatgpt.com.evil.test/backend-api' },
    { ...model, baseUrl: 'http://chatgpt.com/backend-api' },
  ])
    assert.equal(extension.supportedModel(other), false)
})
test('native hook saves/replays compatible checkpoint and current permission-filtered tools', async () => {
  const h = harness(),
    original = globalThis.fetch,
    calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) })
    return sse()
  }
  try {
    const result = await h.compact()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.redirect, 'manual')
    assert.equal(calls[0].body.input.at(-1).type, 'compaction_trigger')
    assert.equal(result.compaction.details.kind, helper.NATIVE_COMPACTION_KIND)
    assert.equal(result.compaction.tokensBefore, 120000)
    assert.equal(result.compaction.usage.output, 40) // generation usage, NOT post-compaction context size
    const c = result.compaction
    h.ctx.sessionManager.appendCompaction(
      c.summary,
      c.firstKeptEntryId,
      c.tokensBefore,
      c.details,
      true,
      c.usage,
    )
    await h.handlers.get('session_compact')({ compactionEntry: { details: c.details } }, h.ctx)
    assert.match(h.statuses.at(-1).text, /OpenAI Codex.*complete/)
    h.ctx.sessionManager.appendMessage({ role: 'user', content: 'Next question', timestamp: 3 })
    const payload = h.handlers.get('before_provider_request')(
      {
        payload: {
          input: [{ type: 'additional_tools', tools: [wireTool, { ...wireTool, name: 'write' }] }],
          previous_response_id: 'old',
        },
      },
      h.ctx,
    )
    assert.equal(payload.input.filter((i) => i.type === 'compaction').length, 1)
    assert.deepEqual(payload.input.at(-1).tools, [wireTool])
    assert.equal(payload.previous_response_id, undefined)
    assert.ok(JSON.stringify(payload).includes('Next question'))
    // A fresh extension instance (resume/reload/fork) must rebuild from native entries, not memory.
    const fresh = harness()
    fresh.ctx.sessionManager = h.ctx.sessionManager
    const restored = fresh.handlers.get('before_provider_request')(
      { payload: { input: [{ type: 'additional_tools', tools: [wireTool] }] } },
      fresh.ctx,
    )
    assert.deepEqual(restored.input, payload.input)
    h.ctx.model = { ...model, id: 'different' }
    h.handlers.get('before_provider_request')({ payload: { input: [] } }, h.ctx)
    assert.equal(h.aborted, true)
    assert.deepEqual(await h.compact(), { cancel: true })
    assert.equal(calls.length, 1)
  } finally {
    globalThis.fetch = original
  }
})
test('existing compaction hooks win with zero duplicate remote requests; reload policy resets', async () => {
  const h = harness(),
    bundled = resolve('resources/codex-compaction/index.ts')
  const own = { resolvedPath: bundled, handlers: h.handlers }
  const other = {
    resolvedPath: '/test/user-plugin.ts',
    handlers: new Map([
      ['session_before_compact', [() => {}]],
      ['before_provider_request', [() => {}]],
    ]),
  }
  const override = compactionPolicyOverride(bundled)
  override({ extensions: [own, other] })
  assert.deepEqual(globalThis[key], { externalCompaction: true, externalReplay: true })
  assert.equal(await h.compact(), undefined)
  override({ extensions: [own] })
  assert.deepEqual(globalThis[key], { externalCompaction: false, externalReplay: false })
})
test('unsupported or absent models keep native compaction with no Codex auth, requests or transforms', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Unexpected Codex network request') }
  try {
    for (const current of [
      undefined,
      { ...model, provider: 'deepseek', api: 'openai-completions' },
      { ...model, provider: 'openai', api: 'openai-responses' },
      { ...model, api: 'openai-responses' },
      { ...model, baseUrl: 'https://proxy.test/backend-api' },
    ]) {
      const h = harness()
      h.ctx.model = current
      h.ctx.modelRegistry.getApiKeyAndHeaders = async () => { throw new Error('Unexpected Codex auth lookup') }
      assert.equal(await h.compact(), undefined)
      assert.equal(h.handlers.get('context')({ messages: [{ role: 'compactionSummary' }] }, h.ctx), undefined)
      assert.equal(h.handlers.get('before_provider_request')({ payload: { messages: [] } }, h.ctx), undefined)
      const headers = {}
      h.handlers.get('before_provider_headers')({ headers }, h.ctx)
      assert.deepEqual(headers, {})
      assert.equal(h.aborted, false)
      assert.deepEqual(h.statuses, [])
      assert.deepEqual(h.notices, [])
    }
  } finally {
    globalThis.fetch = original
  }
})
test('abort and HTTP redirects do not retry or silently fall back to Pi summary', async () => {
  const h = harness(),
    original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response('', { status: 302, headers: { location: 'https://evil.test' } })
  }
  try {
    assert.deepEqual(await h.compact(), { cancel: true })
    assert.equal(calls, 1)
    assert.match(h.notices.at(-1).message, /HTTP 302/)
    const abort = new AbortController()
    abort.abort()
    assert.deepEqual(await h.compact(abort.signal), { cancel: true })
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = original
  }
})
test('retry hints distinguish missing milliseconds from a real zero', () => {
  assert.equal(helper.parseRetryDelay(new Response()), undefined)
  assert.equal(helper.parseRetryDelay(new Response(null, { headers: { 'retry-after': '2' } })), 2000)
  assert.equal(
    helper.parseRetryDelay(new Response(null, { headers: { 'retry-after-ms': '0', 'retry-after': '2' } })),
    0,
  )
  assert.equal(
    helper.parseRetryDelay(
      new Response(null, { headers: { 'retry-after-ms': 'invalid', 'retry-after': '3' } }),
    ),
    3000,
  )
})
test('bounded stream and malformed checkpoint fail closed', async () => {
  await assert.rejects(
    helper.callRemoteCompaction({
      url: 'https://chatgpt.com/backend-api/codex/responses',
      headers: new Headers(),
      body: {},
      model,
      fetchImpl: async () => new Response('x'.repeat(16 * 1024 * 1024 + 1)),
    }),
    /exceeds/,
  )
  const h = harness()
  h.ctx.sessionManager.appendCompaction(
    'marker',
    h.ctx.sessionManager.getBranch()[0].id,
    100,
    { kind: helper.NATIVE_COMPACTION_KIND, version: 1, replacementHistory: [] },
    true,
  )
  assert.deepEqual(await h.compact(), { cancel: true })
  assert.match(h.notices.at(-1).message, /Invalid OpenAI Codex/)
})
test('upstream tools-compat behavior preserves grammar and removes stale synthetic tool loads', () => {
  const checkpoint = { type: 'compaction', encrypted_content: 'opaque' }
  const grammar = {
    type: 'custom',
    name: 'edit',
    format: { type: 'grammar', syntax: 'lark', definition: 'start: "x"' },
  }
  const input = [
    checkpoint,
    { type: 'tool_search_call', call_id: 'pi_tool_load_old' },
    { type: 'function_call', name: 'read', call_id: 'actual' },
  ]
  const result = helper.preserveAdditionalTools(
    { input: [{ type: 'additional_tools', tools: [grammar, wireTool] }] },
    input,
    ['edit'],
  )
  assert.deepEqual(result, [
    checkpoint,
    input[2],
    { type: 'additional_tools', role: 'developer', tools: [grammar] },
  ])
})
