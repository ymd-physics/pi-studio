export interface CodexUsageWindow {
  durationSeconds: 18000 | 604800
  remainingPercent: number
  resetsAt: number | null
}

export type CodexUsageReason =
  | 'not-started'
  | 'stopped'
  | 'no-subscription'
  | 'unsupported-subscription'
  | 'unsupported-runtime'
  | 'untrusted-origin'
  | 'auth-unavailable'
  | 'unauthorized'
  | 'rate-limited'
  | 'invalid-response'
  | 'request-failed'
  | 'timeout'
  | 'account-changed'

/** Safe to serialize; never includes credentials, account identifiers or server error text. */
export interface CodexUsageSnapshot {
  provider: 'openai-codex'
  state: 'ready' | 'unavailable' | 'error'
  reason: CodexUsageReason | null
  capturedAt: number | null
  stale: boolean
  windows: CodexUsageWindow[]
}
