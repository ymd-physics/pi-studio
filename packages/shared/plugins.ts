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
export interface PluginInventory {
  global: PluginEntry[]
  local: PluginEntry[]
  agentDir: string
  workspace?: string
  warnings: string[]
}
