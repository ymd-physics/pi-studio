import { expect, it } from 'vitest'
import { projectTodos, todoGroups } from './todo-state'
it('keeps plan order within each group and puts running work first', () => {
  const groups = todoGroups((['pending', 'completed', 'in_progress', 'pending', 'in_progress'] as const).map((status, id) => ({ status, id, subject: String(id) })))
  expect(groups.active.map(t => t.id)).toEqual([2, 4, 0, 3])
  expect(groups.completed.map(t => t.id)).toEqual([1])
})
const commands = [
  {
    name: 'todos',
    source: 'extension',
    sourceInfo: { path: '/agent/npm/node_modules/@juicesharp/rpiv-todo/index.ts' },
  },
]
const task = (subject: string, status = 'pending') => ({ tasks: [{ id: 1, subject, status }], nextId: 2 })
it('uses current branch custom snapshots, never another branch or a newer legacy result', () => {
  const entries = [
    { id: 'a', parentId: null, type: 'custom', customType: 'rpiv-todo-state', data: task('native') },
    {
      id: 'b',
      parentId: 'a',
      type: 'message',
      message: { role: 'toolResult', toolName: 'todo', details: task('legacy') },
    },
    { id: 'c', parentId: 'a', type: 'custom', customType: 'rpiv-todo-state', data: task('other branch') },
    {
      id: 'd',
      parentId: 'b',
      type: 'custom',
      customType: 'rpiv-todo-state',
      data: { tasks: [{ id: -1 }], nextId: 2 },
    },
  ]
  expect(projectTodos(commands, { entries, leafId: 'd' }).tasks[0].subject).toBe('native')
  expect(projectTodos(commands, { entries, leafId: 'c' }).tasks[0].subject).toBe('other branch')
})
it('distinguishes missing plugin, unavailable history, and an empty/deleted-only state', () => {
  expect(projectTodos([]).availability).toBe('disabled')
  expect(projectTodos([{ name: 'todos', source: 'extension' }]).availability).toBe('disabled')
  expect(projectTodos(commands).availability).toBe('unavailable')
  expect(projectTodos(commands, { entries: [], leafId: null })).toEqual({
    availability: 'enabled',
    tasks: [],
  })
  expect(
    projectTodos(commands, {
      entries: [{ id: 'a', type: 'custom', customType: 'rpiv-todo-state', data: task('gone', 'deleted') }],
      leafId: 'a',
    }).tasks,
  ).toEqual([])
})
