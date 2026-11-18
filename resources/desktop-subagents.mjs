import { randomUUID } from 'node:crypto'

// Optional integration with pi-subagents' public v1 event-bus API. Execution,
// ownership checks and process cancellation stay in the installed plugin.
export function bindSubagentShutdown(pi) {
  let ready = false
  const launched = new Set()
  pi.events.on('subagents:rpc:v1:ready', () => { ready = true })
  pi.events.on('subagent:async-started', (event) => {
    if (typeof event?.id === 'string') launched.add(event.id)
  })
  pi.events.on('subagent:process-terminal', (event) => {
    if (event?.state === 'observed') launched.delete(event.runId)
  })
  const request = (method, params) => new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply) => {
      clearTimeout(timer)
      off()
      if (reply.success) resolve(reply.data)
      else reject(Object.assign(new Error(reply.error?.message || 'Subagent request failed'), { code: reply.error?.code }))
    })
    const timer = setTimeout(() => { off(); reject(new Error('Subagent shutdown request timed out')) }, 1500)
    pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method, params })
  })
  pi.on('session_shutdown', async (event) => {
    // Reload/fork must not stop otherwise independent native child work.
    if (event.reason !== 'quit' || !ready) return
    try {
      // Include restored jobs as well as all launches observed by this host.
      // The snapshot alone is bounded, so it must not replace the launch set.
      const status = await request('status')
      for (const run of status.asyncSnapshot?.runs || []) {
        if (run.state === 'running' || run.state === 'queued') launched.add(run.id)
      }
      await Promise.all([...launched].map(async (id) => {
        try { await request('stop', { id }) }
        catch (error) {
          // Completion can race shutdown. The plugin enforces session ownership.
          if (error.code !== 'invalid_state' && error.code !== 'not_found') throw error
        }
      }))
    } catch (error) {
      console.error(`Pi Studio could not request native subagent shutdown: ${error.message}`)
    }
  })
}
