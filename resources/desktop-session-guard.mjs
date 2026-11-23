// Pi Desktop owns process-to-file bindings. Native extension commands remain available,
// but resuming another file must go through the sidebar so two workers cannot share it.
// This is an ordinary per-process Pi extension, never installed into the user's config.
import { bindSubagentShutdown } from './desktop-subagents.mjs'
import { bindSubagentStatus } from './desktop-subagent-status.mjs'

import { randomUUID } from 'node:crypto'
import { branchTodos, todoGroups, TODO_PAGE_SIZE, TODO_WIDGET } from '../packages/shared/todo-state.ts'

export default function desktopSessionGuard(pi) {
  // Project from the native session's parent index, never serialize its history.
  let timer, revision, groups
  // Private parent/child IPC: paged reads never become prompts or mutate Pi history.
  const onPage = message => {
    if (message?.type !== 'desktop_todo_page' || !process.connected) return
    const { id, group, offset } = message
    const valid = revision && message.revision === revision && (group === 'active' || group === 'completed') && Number.isSafeInteger(offset) && offset >= 0
    const rows = valid ? groups[group].slice(offset, offset + TODO_PAGE_SIZE) : undefined
    process.send({ type: 'desktop_todo_page', id, rows }, () => {})
  }
  process.on('message', onPage)
  const schedule = (_event, ctx) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        const sm = ctx.sessionManager
        const state = branchTodos(sm.getLeafId(), id => sm.getEntry(id))
        groups = todoGroups(state.tasks)
        revision = randomUUID()
        ctx.ui.setWidget(TODO_WIDGET, [JSON.stringify({ availability: state.availability, total: state.tasks.length, completed: groups.completed.length, revision })])
      } catch { /* Optional projection; never disrupt the native session. */ }
    }, 0)
  }
  for (const name of ['session_start', 'session_tree', 'session_compact']) pi.on(name, schedule)
  pi.on('tool_execution_end', (event, ctx) => { if (event.toolName === 'todo') schedule(event, ctx) })
  pi.on('session_shutdown', () => { clearTimeout(timer); process.off('message', onPage); groups = undefined; revision = undefined })
  bindSubagentShutdown(pi)
  bindSubagentStatus(pi)
  pi.on('session_before_switch', (event, ctx) => {
    if (event.reason !== 'resume') return
    ctx.ui.notify('Open sessions from the Pi Studio sidebar. Extension-driven session switching is disabled to prevent concurrent writers.', 'warning')
    return { cancel: true }
  })
}
