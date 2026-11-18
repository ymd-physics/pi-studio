import { useUiText } from './language'
import { useEffect, useState } from 'react'
import { Check, CircleAlert, LoaderCircle, Minimize2 } from 'lucide-react'
import { Markdown } from './Markdown'
import { elapsed, type CompactionActivity } from './activity'
const tokens = (n: number) => Math.round(n).toLocaleString('en-US')
const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

export function CompactionNotice({
  value,
  modelProvider,
}: {
  value: CompactionActivity
  modelProvider?: string
}) {
  const t = useUiText()
  const running = value.status === 'running'
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!running) return
    setNow(performance.now())
    const timer = setInterval(() => setNow(performance.now()), 500)
    return () => clearInterval(timer)
  }, [running, value.started])
  const title = running
    ? 'Compacting…'
    : value.status === 'complete'
      ? 'Context compacted'
      : value.status === 'cancelled'
        ? 'Compaction cancelled'
        : value.status === 'failed'
          ? 'Compaction failed'
          : 'Compaction command completed'
  const codex =
    value.engine === 'openai-codex' ||
    value.result?.details?.kind === 'openai-codex-native-compaction' ||
    value.result?.summary?.startsWith('OpenAI Codex native compaction checkpoint (')
  const before = value.result?.tokensBefore,
    after = value.result?.estimatedTokensAfter
  return (
    <section className={`compaction-notice ${value.status}`} aria-label={t("Compaction")} aria-live="polite">
      <div className="compaction-heading" role="status">
        {running ? (
          <LoaderCircle size={15} className="spin" />
        ) : value.status === 'complete' ? (
          <Check size={15} />
        ) : value.status === 'failed' ? (
          <CircleAlert size={15} />
        ) : (
          <Minimize2 size={15} />
        )}
        <strong>{codex ? `OpenAI Codex · ${t(title)}` : t(title)}</strong>
        {running && !codex && modelProvider === 'openai-codex' && (
          <small
            className="compaction-model"
            title={t("Current model provider. The extension has not reported its compaction engine yet; the completion result will identify it.")}
          >{t("Model: OpenAI Codex")}</small>
        )}
        {value.started !== undefined && <small>{elapsed((value.ended ?? now) - value.started)}</small>}
        {value.reason && value.reason !== 'manual' && <small>{t("Automatic")}</small>}
      </div>
      {value.status === 'complete' && (valid(before) || valid(after)) && (
        <div
          className="compaction-counts"
          title={t("Native Pi context estimate, not summary-generation usage. Extensions may further transform the provider payload.")}
        >
          <span>{valid(before) ? tokens(before) : t('Unknown')}</span>
          <span aria-hidden="true">→</span>
          <strong>{valid(after) ? `≈ ${tokens(after)}` : t('Unknown')}</strong>
          <span>{t("tokens")}</span>
          <small>{valid(after) ? t('Pi estimate') : t('Post-compaction estimate unavailable')}</small>
        </div>
      )}
      {codex && value.status === 'complete' && (
        <p>{t("Encrypted checkpoint saved. Pi’s estimate does not measure the encrypted OpenAI context.")}</p>
      )}
      {value.notices.map((notice) =>
        notice.text.length <= 10000 ? (
          <p key={notice.key} className={notice.error ? 'compaction-error' : ''}>
            {notice.text}
          </p>
        ) : (
          <details key={notice.key}>
            <summary>{notice.text.slice(0, 160)}{t("… — expand full message")}</summary>
            <p className={notice.error ? 'compaction-error' : ''}>{notice.text}</p>
          </details>
        ),
      )}
      {value.error && <p className="compaction-error">{value.error}</p>}
      {value.status === 'handled' && !value.notices.length && (
        <p>{t("The extension returned without a native compaction result.")}</p>
      )}
      {value.result?.summary && (
        <details>
          <summary>{t("Compaction summary")}</summary>
          <Markdown text={value.result.summary.slice(0, 30000)} />
          {value.result.summary.length > 30000 && (
            <small>{t("Preview limited; full summary retained in the Pi session.")}</small>
          )}
        </details>
      )}
    </section>
  )
}
