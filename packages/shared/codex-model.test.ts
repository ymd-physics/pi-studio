import { describe, expect, it } from 'vitest'
import { supportsCodexFeatures } from './codex-model'

const model = { provider: 'openai-codex', api: 'openai-codex-responses' }
describe('supportsCodexFeatures', () => {
  it.each([
    undefined,
    '',
    'https://chatgpt.com/backend-api',
    ' https://chatgpt.com/backend-api/ ',
    'https://chatgpt.com/backend-api/codex',
    'https://chatgpt.com/backend-api/codex/responses/',
  ])('accepts the supported Codex family and official endpoint: %s', (baseUrl) => {
    expect(supportsCodexFeatures({ ...model, baseUrl })).toBe(true)
  })
  it.each([
    undefined,
    null,
    {},
    { provider: 'openai-codex' },
    { provider: 'deepseek', api: 'openai-completions' },
    { provider: 'openai', api: 'openai-responses' },
    { ...model, provider: 'custom' },
    { ...model, api: 'openai-responses' },
    { ...model, baseUrl: 'https://proxy.test/backend-api' },
    { ...model, baseUrl: 'https://chatgpt.com.evil.test/backend-api' },
    { ...model, baseUrl: 'http://chatgpt.com/backend-api' },
    { ...model, baseUrl: 'https://user:password@chatgpt.com/backend-api' },
    { ...model, baseUrl: 'https://chatgpt.com/backend-api?override=1' },
    { ...model, baseUrl: 'https://chatgpt.com/backend-api#fragment' },
    { ...model, baseUrl: 'not a URL' },
  ])('rejects absent, unrelated and overridden models: %j', (candidate) => {
    expect(supportsCodexFeatures(candidate)).toBe(false)
  })
})
