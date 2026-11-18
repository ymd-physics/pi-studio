import { useEffect, useState } from 'react'
import { Gauge, Info } from 'lucide-react'
import type { CodexUsageReason, CodexUsageSnapshot } from '../../../../packages/shared/codex-usage'

const reasons: Partial<Record<CodexUsageReason, string>> = {
  'unsupported-subscription':
    'This OpenAI subscription uses a newer login protocol whose allowance endpoint is not supported yet.',
  'unsupported-runtime': 'Your Pi installation does not expose the native subscription authentication API.',
  'untrusted-origin': 'Quota lookup is disabled for custom authentication endpoints.',
  'auth-unavailable': 'Subscription authentication is unavailable. Check your login in terminal Pi.',
  unauthorized: 'Subscription authentication was rejected. Check your login in terminal Pi.',
  'rate-limited': 'The quota service is rate limiting requests. Retrying automatically.',
  'invalid-response': 'The quota service returned an unsupported response.',
  'request-failed': 'Could not reach the quota service. Retrying automatically.',
  timeout: 'The quota request timed out. Retrying automatically.',
}
function resetCountdown(resetsAt: number | null, now: number): string {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return 'Reset time unavailable'
  const minutes = Math.ceil((resetsAt * 1000 - now) / 60000)
  if (minutes <= 0) return 'Reset due · awaiting update'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const remainder = minutes % 60
  return `Resets in ${[days && `${days}d`, hours && `${hours}h`, remainder && `${remainder}m`].filter(Boolean).join(' ')}`
}

export function CodexQuota({ usage }: { usage?: CodexUsageSnapshot }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    setNow(Date.now())
    if (!usage?.windows.some((window) => window.resetsAt !== null && Number.isFinite(window.resetsAt))) return
    const timer = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(timer)
  }, [usage])
  if (!usage || ['not-started', 'stopped', 'no-subscription', 'account-changed'].includes(usage.reason || ''))
    return null
  const reason = usage.reason && reasons[usage.reason]
  return (
    <div className={`codex-quota ${usage.stale ? 'stale' : ''}`} aria-label="Codex subscription allowance">
      <span className="quota-label">
        <Gauge size={12} /> Codex
      </span>
      {usage.windows.map((window) => (
        <span
          className="quota-window"
          key={window.durationSeconds}
          title={`${window.remainingPercent.toFixed(1)}% remaining${window.resetsAt !== null && Number.isFinite(window.resetsAt) ? ` · Resets ${new Date(window.resetsAt * 1000).toLocaleString()}` : ''}${usage.capturedAt ? ` · Updated ${new Date(usage.capturedAt).toLocaleTimeString()}` : ''}`}
        >
          <span>{window.durationSeconds === 18000 ? '5h' : 'Week'}</span>
          <span className="quota-track" aria-hidden="true">
            <span style={{ width: `${window.remainingPercent}%` }} />
          </span>
          <span>{Math.round(window.remainingPercent)}% left</span>
          <span className="quota-reset">{resetCountdown(window.resetsAt, now)}</span>
        </span>
      ))}
      {(reason || usage.stale || usage.state !== 'ready') && (
        <span className="quota-unavailable" title={reason || (usage.stale ? 'Showing the last known allowance; awaiting fresh data.' : 'Allowance data is unavailable.')}>
          <Info size={11} />
          {usage.stale ? 'Update delayed' : 'Quota unavailable'}
        </span>
      )}
    </div>
  )
}
