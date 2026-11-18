import type { Command } from './desktop'
export interface TodoTask {
  id: number
  subject: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  description?: string
  activeForm?: string
  blockedBy?: number[]
}
export interface TodoState {
  availability: 'enabled' | 'disabled' | 'unavailable'
  tasks: TodoTask[]
}
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0
function tasks(data: any): TodoTask[] | undefined {
  if (!data || !integer(data.nextId) || !Array.isArray(data.tasks)) return
  if (
    !data.tasks.every(
      (t: any) =>
        t &&
        integer(t.id) &&
        typeof t.subject === 'string' &&
        ['pending', 'in_progress', 'completed', 'deleted'].includes(t.status) &&
        ['description', 'activeForm', 'owner'].every(
          (key) => t[key] === undefined || typeof t[key] === 'string',
        ) &&
        (t.blockedBy === undefined || (Array.isArray(t.blockedBy) && t.blockedBy.every(integer))) &&
        (t.metadata === undefined ||
          (t.metadata !== null && typeof t.metadata === 'object' && !Array.isArray(t.metadata))),
    )
  )
    return
  return data.tasks
}
/** Read-only replay matching rpiv-todo: current ancestry, custom state before legacy tool results. */
export function projectTodos(
  commands: Command[],
  data?: { entries: any[]; leafId: string | null },
): TodoState {
  const enabled = commands.some(
    (c) =>
      c.name === 'todos' &&
      c.source === 'extension' &&
      /(?:^|[/\\])(?:@juicesharp[/\\])?rpiv-todo(?:[/\\]|$)/.test(c.sourceInfo?.path || ''),
  )
  if (!enabled) return { availability: 'disabled', tasks: [] }
  if (!data || !Array.isArray(data.entries)) return { availability: 'unavailable', tasks: [] }
  const entries = new Map(data.entries.map((entry) => [entry.id, entry]))
  const branch: any[] = [],
    seen = new Set<string>()
  let id = data.leafId
  while (id) {
    if (seen.has(id) || !entries.has(id)) return { availability: 'unavailable', tasks: [] }
    seen.add(id)
    const entry = entries.get(id)
    branch.push(entry)
    id = entry.parentId
  }
  let custom: TodoTask[] | undefined, legacy: TodoTask[] | undefined
  for (const entry of branch.reverse()) {
    if (entry.type === 'custom' && entry.customType === 'rpiv-todo-state')
      custom = tasks(entry.data) ?? custom
    if (entry.type === 'message' && entry.message?.role === 'toolResult' && entry.message.toolName === 'todo')
      legacy = tasks(entry.message.details) ?? legacy
  }
  return { availability: 'enabled', tasks: (custom ?? legacy ?? []).filter((t) => t.status !== 'deleted') }
}
