/** Model identity for both Codex allowance display and bundled remote compaction.
 * Do not infer support from a model's name, account presence, or quota response.
 */
export function supportsCodexFeatures(model?: {
  provider?: string
  api?: string
  baseUrl?: string
} | null): boolean {
  if (model?.provider !== 'openai-codex' || model.api !== 'openai-codex-responses') return false
  try {
    // Match the bundled compressor's resolveCodexResponsesUrl normalization.
    const base = (model.baseUrl?.trim() || 'https://chatgpt.com/backend-api').replace(/\/+$/, '')
    const endpoint = base.endsWith('/codex/responses')
      ? base
      : base.endsWith('/codex')
        ? `${base}/responses`
        : `${base}/codex/responses`
    return new URL(endpoint).href === 'https://chatgpt.com/backend-api/codex/responses'
  } catch {
    return false
  }
}
