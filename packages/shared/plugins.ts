import type { AdaptedPlugin } from './compatibility'

// Read-only native resource inventory. Presence is not proof of loading in a session.
export interface PluginEntry {
  id: string
  name: string
  source: string
  scope: 'global' | 'local'
  state: 'installed' | 'configured' | 'missing' | 'disabled'
  adapted?: AdaptedPlugin
  version?: string
  description?: string
}
export type PluginWarning = string | { message: string; values: Record<string, string | number> }
export function formatPluginWarning(warning: PluginWarning, t: ReturnType<typeof import('./language').uiText>) {
  return typeof warning === 'string' ? t(warning) : t(warning.message, warning.values)
}
export interface PluginInventory {
  global: PluginEntry[]
  local: PluginEntry[]
  agentDir: string
  workspace?: string
  warnings: PluginWarning[]
}
