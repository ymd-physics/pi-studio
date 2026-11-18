// Adapted from @ogulcancelik/pi-codex-compaction 0.1.6 + the user's tools-compat patch.
// See LICENSE and LOCAL-SOURCE.json. Pi, not Desktop, owns execution and persistence.
import { randomUUID } from 'node:crypto'
import { supportsCodexFeatures } from '../../packages/shared/codex-model.ts'
import {
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent'
import {
  buildCodexHeaders,
  buildCompactionRequestBody,
  buildReplacementHistory,
  buildToolPayload,
  callRemoteCompaction,
  effectiveInputForBranch,
  findNativeCheckpoint,
  isJsonObject,
  mergeFeatureHeader,
  modelKey,
  NATIVE_COMPACTION_KIND,
  NATIVE_COMPACTION_VERSION,
  preserveAdditionalTools,
  resolveCodexResponsesUrl,
  stripInputFromPayload,
  type JsonObject,
} from './native-compaction.ts'

export function supportedHost(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/.exec(version)
  return !!match && (+match[1] > 1 || (+match[1] === 1 && +match[2] >= 4))
}

// Share admission with the allowance UI; never widen to generic OpenAI models.
export const supportedModel = supportsCodexFeatures

const policy = () =>
  (globalThis as any)[Symbol.for('pi-desktop.compaction-policy')] as
    { externalCompaction: boolean } | undefined
const statusKey = 'pi-desktop-openai-compaction'
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export default function codexCompaction(pi: ExtensionAPI) {
  if (!supportedHost(VERSION)) return
  const shapes = new Map<string, { model: string; payload: JsonObject }>()
  const checkpoint = (ctx: ExtensionContext) =>
    findNativeCheckpoint(ctx.sessionManager.getBranch() as SessionEntry[])
  const checkpointProblem = (ctx: ExtensionContext): string | undefined => {
    const found = checkpoint(ctx)
    if (found.status === 'none') return
    if (found.status === 'invalid')
      return 'Invalid OpenAI Codex checkpoint. Branch before compaction to recover; no model request was sent.'
    if (!supportedModel(ctx.model) || found.checkpoint.details.modelKey !== modelKey(ctx.model!)) {
      return 'This branch contains an encrypted OpenAI Codex checkpoint. Select its original Codex model and standard endpoint, or branch before compaction. It cannot be replayed with a different model/provider.'
    }
  }
  const notifyProblem = (ctx: ExtensionContext, message: string) => ctx.ui.notify(message, 'error')
  const clear = () => shapes.clear()
  pi.on('session_start', (_event, ctx) => {
    clear()
    const problem = checkpointProblem(ctx)
    if (problem) notifyProblem(ctx, problem)
  })
  pi.on('session_shutdown', clear)
  pi.on('agent_start', (_event, ctx) => ctx.ui.setStatus(statusKey, undefined))
  pi.on('model_select', (_event, ctx) => {
    clear()
    const problem = checkpointProblem(ctx)
    if (problem) notifyProblem(ctx, problem)
  })

  pi.on('context', (event, ctx) => {
    if (checkpointProblem(ctx) || checkpoint(ctx).status === 'none') return
    return { messages: event.messages.filter((message) => message.role !== 'compactionSummary') }
  })
  pi.on('before_provider_headers', (event, ctx) => {
    if (!supportedModel(ctx.model)) return
    const key =
      Object.keys(event.headers).find((key) => key.toLowerCase() === 'x-codex-beta-features') ??
      'x-codex-beta-features'
    event.headers[key] = mergeFeatureHeader(event.headers[key])
  })
  pi.on('before_provider_request', (event, ctx) => {
    const problem = checkpointProblem(ctx)
    if (problem) {
      ctx.abort()
      notifyProblem(ctx, problem)
      // Abort is authoritative; also never supply the misleading marker-only context.
      return isJsonObject(event.payload) ? { ...event.payload, input: [], messages: [] } : undefined
    }
    if (!supportedModel(ctx.model) || !isJsonObject(event.payload)) return
    const model = ctx.model!
    shapes.set(ctx.sessionManager.getSessionId(), {
      model: modelKey(model),
      payload: stripInputFromPayload(event.payload),
    })
    if (checkpoint(ctx).status === 'none') return
    try {
      const input = preserveAdditionalTools(
        event.payload,
        effectiveInputForBranch({
          branch: ctx.sessionManager.getBranch() as SessionEntry[],
          model,
          tools: pi.getAllTools(),
        }),
        pi.getActiveTools(),
      )
      const payload: JsonObject = { ...event.payload, input }
      delete payload.messages
      delete payload.previous_response_id
      return payload
    } catch (error) {
      ctx.abort()
      notifyProblem(ctx, `OpenAI Codex request blocked: ${errorText(error)}`)
      return { ...event.payload, input: [], messages: [] }
    }
  })

  pi.on('session_before_compact', async (event, ctx) => {
    const problem = checkpointProblem(ctx)
    if (problem) {
      ctx.ui.setStatus(statusKey, 'OpenAI Codex · Compaction failed')
      notifyProblem(ctx, problem)
      return { cancel: true }
    }
    // User-installed hook owns compaction. Never perform a second remote request.
    if (policy()?.externalCompaction) return
    if (!supportedModel(ctx.model)) return
    const model = ctx.model!
    ctx.ui.setStatus(statusKey, 'OpenAI Codex · Compacting…')
    try {
      const input = effectiveInputForBranch({
        branch: event.branchEntries as SessionEntry[],
        model,
        tools: pi.getAllTools(),
        excludeLastAssistantError: event.reason === 'overflow' && event.willRetry,
      })
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
      if (!auth.ok || !auth.apiKey)
        throw new Error(auth.ok ? 'OpenAI Codex authentication is unavailable.' : auth.error)
      event.signal.throwIfAborted()
      const sessionId = ctx.sessionManager.getSessionId()
      const cached = shapes.get(sessionId)
      const body = buildCompactionRequestBody({
        model,
        input,
        sessionId,
        instructions: ctx.getSystemPrompt(),
        tools: buildToolPayload(pi.getAllTools(), pi.getActiveTools()),
        basePayload: cached?.model === modelKey(model) ? cached.payload : undefined,
      })
      const remote = await callRemoteCompaction({
        url: resolveCodexResponsesUrl(model.baseUrl),
        headers: buildCodexHeaders({ apiKey: auth.apiKey, headers: auth.headers, sessionId }),
        body,
        model,
        signal: event.signal,
      })
      return {
        compaction: {
          summary: `OpenAI Codex native compaction checkpoint (${randomUUID()}).`,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: remote.usage,
          details: {
            kind: NATIVE_COMPACTION_KIND,
            version: NATIVE_COMPACTION_VERSION,
            modelKey: modelKey(model),
            replacementHistory: buildReplacementHistory(input, remote.compactionItem),
          },
        },
      }
    } catch (error) {
      ctx.ui.setStatus(
        statusKey,
        event.signal.aborted ? 'OpenAI Codex · Compaction cancelled' : 'OpenAI Codex · Compaction failed',
      )
      if (!event.signal.aborted) notifyProblem(ctx, `OpenAI Codex compaction failed: ${errorText(error)}`)
      return { cancel: true }
    }
  })
  pi.on('session_compact', (event, ctx) => {
    if (
      isJsonObject(event.compactionEntry.details) &&
      event.compactionEntry.details.kind === NATIVE_COMPACTION_KIND
    ) {
      ctx.ui.setStatus(statusKey, 'OpenAI Codex · Compaction complete')
    } else ctx.ui.setStatus(statusKey, undefined)
  })
}
