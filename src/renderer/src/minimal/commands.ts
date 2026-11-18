import type { Command } from '../../../../packages/shared/desktop'

// These are only desktop adapters for native TUI built-ins, never an extension allowlist.
// Audited against Pi 1.5's BUILTIN_SLASH_COMMANDS; registered native resources always win.
export const desktopCommands: Command[] = [
  { name: 'new', description: 'New native Pi session', source: 'desktop' },
  { name: 'compact', description: 'Compact the conversation', source: 'desktop' },
  { name: 'name', description: 'Rename the active session', source: 'desktop' },
  { name: 'fork', description: 'Fork from an earlier message', source: 'desktop' },
  { name: 'clone', description: 'Duplicate the current branch into a new session', source: 'desktop' },
  { name: 'tree', description: 'Inspect the native session tree', source: 'desktop' },
  { name: 'reload', description: 'Reload Pi resources in the same session', source: 'desktop' },
  { name: 'copy', description: 'Copy the last assistant response', source: 'desktop' },
  { name: 'session', description: 'Show native session information', source: 'desktop' },
  { name: 'export', description: 'Export the session as HTML', source: 'desktop' },
  { name: 'resume', description: 'Choose a session in the sidebar', source: 'desktop' },
  { name: 'quit', description: 'Quit Pi Studio', source: 'desktop' },
]

// Interactive built-ins that RPC prompt does NOT execute. Do not let these accidentally
// become model prompts. Resource-defined commands with the same name remain callable.
export const terminalCommands: Record<string, string> = {
  model: 'Use the model selector in the composer.',
  thinking: 'Use the thinking selector in the composer.',
  settings: 'Use Preferences for desktop settings; use terminal Pi for agent settings.',
  'scoped-models': 'Configure scoped models in terminal Pi.',
  login: 'Authenticate with /login in terminal Pi, then /reload here.',
  logout: 'Manage provider authentication in terminal Pi, then /reload here.',
  trust:
    'Workspaces added through the desktop trust dialog are approved for the active Pi process. Manage saved Pi trust in the terminal.',
  import: 'Session import has no native RPC operation. Import with terminal Pi, then refresh this workspace.',
  share: 'Use /share in terminal Pi; native RPC does not expose sharing.',
  bug: 'Use /bug in terminal Pi.',
  hotkeys: 'Cmd+N: new session · Cmd+B: sidebar · Cmd+L: composer · Escape: stop.',
  changelog: 'Use /changelog in terminal Pi.',
}

export function commandCatalog(native: Command[]): Command[] {
  return [...native, ...desktopCommands.filter((c) => !native.some((n) => n.name === c.name))].sort((a, b) =>
    a.name.localeCompare(b.name),
  )
}

export function routeCommand(text: string, native: Command[]) {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!match) return { kind: 'native' as const, name: '', args: '' }
  const [, name, args = ''] = match
  if (native.some((c) => c.name === name)) return { kind: 'native' as const, name, args }
  if (desktopCommands.some((c) => c.name === name)) return { kind: 'desktop' as const, name, args }
  if (Object.hasOwn(terminalCommands, name)) return { kind: 'terminal' as const, name, args }
  // Extensions can also handle input hooks without registering a slash command.
  // Match native Pi behavior: pass unknown, non-built-in input through unchanged.
  return { kind: 'native' as const, name, args }
}
