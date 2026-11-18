// Safe per-session projection of the installed pi-subagents status API.
export interface SubagentCard {
  id: string
  name: string
  task?: string
  model?: string
  thinking?: string
  state: 'running' | 'queued' | 'waiting' | 'complete' | 'failed' | 'stopped' | 'paused' | 'unknown'
  startedAt?: number
  endedAt?: number
  activity?: string
  parentId?: string
}
export interface SubagentStatus {
  availability: 'available' | 'unavailable'
  agents: SubagentCard[]
  updatedAt: number
  error?: string
  omitted?: number
}

export const SUBAGENT_STATUS_WIDGET = '__pi_desktop_subagents_v1__'
export function parseSubagentStatus(value: unknown): SubagentStatus | undefined {
  if (typeof value !== 'string' || value.length > 256 * 1024) return
  try {
    const status = JSON.parse(value)
    if (status?.availability !== 'available' || !Array.isArray(status.agents) || status.agents.length > 128) return
    const valid = ['running', 'queued', 'waiting', 'complete', 'failed', 'stopped', 'paused', 'unknown']
    const text = (s: unknown, max = 512) => typeof s === 'string' ? s.slice(0, max) : undefined
    const timestamp = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
    const seen = new Set<string>()
    const agents: SubagentCard[] = []
    for (const a of status.agents) {
      if (!a || typeof a.id !== 'string' || !a.id || seen.has(a.id) || !valid.includes(a.state)) continue
      seen.add(a.id)
      agents.push({ id: a.id.slice(0, 1600), name: text(a.name, 100) || 'Subagent', state: a.state,
        task: text(a.task), model: text(a.model, 160), thinking: text(a.thinking, 30),
        activity: text(a.activity), startedAt: timestamp(a.startedAt), endedAt: timestamp(a.endedAt), parentId: text(a.parentId, 1600) })
    }
    return { availability: 'available', agents, updatedAt: timestamp(status.updatedAt) ?? Date.now(),
      error: text(status.error), omitted: timestamp(status.omitted) }
  } catch { return }
}
