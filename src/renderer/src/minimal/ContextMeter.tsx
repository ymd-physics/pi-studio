import { useUiText } from './language'
import { useState } from 'react'
import type { ContextUsage } from '../../../../packages/shared/desktop'

const count = (n: number) => (n >= 1000 ? `${Number((n / 1000).toFixed(1))}k` : String(Math.round(n)))
export function ContextMeter({ usage }: { usage?: ContextUsage }) {
  const t = useUiText()
  const [open, setOpen] = useState(false)
  const available = usage && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
  const known =
    available &&
    usage.tokens !== null &&
    Number.isFinite(usage.tokens) &&
    usage.percent !== null &&
    Number.isFinite(usage.percent)
  const percent = known ? Math.max(0, usage.percent!) : undefined
  const filled = Math.min(100, percent ?? 0)
  const tone =
    percent === undefined ? 'unknown' : percent >= 85 ? 'critical' : percent >= 65 ? 'warm' : 'normal'
  const amount = known
    ? `${count(usage.tokens!)} / ${count(usage.contextWindow)}`
    : available
      ? `— / ${count(usage.contextWindow)}`
      : t('Unavailable')
  const label = percent === undefined ? t('Unknown') : `${Number(percent.toFixed(1))}%`
  return (
    <div
      className={`context-meter ${tone} ${open ? 'open' : ''}`}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false)
      }}
    >
      <button
        type="button"
        className="context-toggle"
        aria-label={t('Context window: {label}, {amount}', { label, amount })}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setOpen(false)
            e.currentTarget.blur()
          }
        }}
      >
        <svg
          width="26"
          height="26"
          viewBox="0 0 28 28"
          role="progressbar"
          aria-label={t("Context used")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent === undefined ? undefined : filled}
          aria-valuetext={known ? t('{used} of {capacity} tokens', { used: usage.tokens!, capacity: usage.contextWindow }) : t('Estimate unavailable')}
          style={{ color: `color-mix(in srgb, var(--accent), #db5757 ${(filled * filled) / 100}%)` }}
        >
          <circle className="context-ring-track" cx="14" cy="14" r="10" />
          <circle
            className="context-ring-fill"
            cx="14"
            cy="14"
            r="10"
            pathLength="100"
            strokeDasharray="100"
            strokeDashoffset={100 - filled}
            transform="rotate(-90 14 14)"
          />
        </svg>
      </button>
      <div className="context-detail" role="tooltip">
        <span>{t("Context window")}<strong>{label}</strong>
        </span>
        <b>{amount}</b>
        <small>
          {known
            ? t('Tokens · estimated by Pi')
            : t('Estimate unavailable after compaction or without model usage')}
        </small>
      </div>
    </div>
  )
}
