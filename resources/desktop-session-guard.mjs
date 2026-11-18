// Pi Desktop owns process-to-file bindings. Native extension commands remain available,
// but resuming another file must go through the sidebar so two workers cannot share it.
// This is an ordinary per-process Pi extension, never installed into the user's config.
import { bindSubagentShutdown } from './desktop-subagents.mjs'
import { bindSubagentStatus } from './desktop-subagent-status.mjs'

export default function desktopSessionGuard(pi) {
  bindSubagentShutdown(pi)
  bindSubagentStatus(pi)
  pi.on('session_before_switch', (event, ctx) => {
    if (event.reason !== 'resume') return
    ctx.ui.notify('Open sessions from the Pi Studio sidebar. Extension-driven session switching is disabled to prevent concurrent writers.', 'warning')
    return { cancel: true }
  })
}
