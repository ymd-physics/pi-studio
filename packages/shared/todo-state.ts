import type { Command } from './desktop'
export interface TodoTask {
  id: number
  subject: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  description?: string
  activeForm?: string
  blockedBy?: number[]
}
export interface TodoSummary {
  availability: 'enabled' | 'disabled' | 'unavailable'
  total: number
  completed: number
  revision: string
}
export const TODO_PAGE_SIZE = 24
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
  return branchTodos(data.leafId, id => entries.get(id))
}

export const TODO_WIDGET = '__pi_desktop_todos_v1__'

export function parseTodoWidget(line: unknown): TodoSummary {
  if (typeof line === 'string' && line.length <= 512 * 1024) {
    try {
      const state = JSON.parse(line)
      if (state?.availability === 'enabled' && Number.isSafeInteger(state.total) && state.total >= 0 &&
          Number.isSafeInteger(state.completed) && state.completed >= 0 && state.completed <= state.total && typeof state.revision === 'string')
        return { availability: 'enabled', total: state.total, completed: state.completed, revision: state.revision }
    } catch { /* ignore malformed optional plugin state */ }
  }
  return { availability: 'unavailable', total: 0, completed: 0, revision: '' }
}

export function todoGroups(tasks: TodoTask[]) {
  return {
    active: [...tasks.filter(t => t.status === 'in_progress'), ...tasks.filter(t => t.status === 'pending')],
    completed: tasks.filter(t => t.status === 'completed'),
  }
}

/** Walk Pi's in-memory parent index; unrelated messages never cross RPC. */
export function branchTodos(id: string | null, getEntry: (id: string) => any): TodoState {
  const seen = new Set<string>()
  let legacy: TodoTask[] | undefined
  while (id) {
    const entry = getEntry(id)
    if (seen.has(id) || !entry) return { availability: 'unavailable', tasks: [] }
    seen.add(id)
    if (entry.type === 'custom' && entry.customType === 'rpiv-todo-state') {
      const current = tasks(entry.data)
      if (current) { legacy = current; break }
    }
    if (!legacy && entry.type === 'message' && entry.message?.role === 'toolResult' && entry.message.toolName === 'todo')
      legacy = tasks(entry.message.details)
    id = entry.parentId
  }
  return { availability: 'enabled', tasks: (legacy ?? []).filter(t => t.status !== 'deleted').map(
    ({ id, subject, status, description, activeForm, blockedBy }) => ({ id, subject, status, description, activeForm, blockedBy })
  ) }
}
