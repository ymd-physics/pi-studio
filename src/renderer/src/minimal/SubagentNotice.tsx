import { useUiText } from './language'
import { useId, useState } from 'react'
import { CircleAlert, MessageSquareWarning, Check, Info } from 'lucide-react'
import type { Message } from '../../../../packages/shared/desktop'
import { noticeMetadata, noticeText, type SubagentNoticeView, type SupervisorRequest } from './subagent-notices'
import './subagent-notice.css'

export function SubagentNotice({ message, view, onDraft, onRequest, requestIds }: {
  message: Message
  view: SubagentNoticeView
  onDraft?: (request: SupervisorRequest) => void
  onRequest?: (id: string) => void
  requestIds?: ReadonlySet<string>
}) {
  const t = useUiText()
  const [expanded, setExpanded] = useState(false)
  const [nativeOpen, setNativeOpen] = useState(false)
  const bodyId = useId()
  const expandable = view.body.length > 140 || view.body.split('\n').length > 3
  const Icon = view.tone === 'error' ? CircleAlert : view.tone === 'result' ? Check : view.tone === 'attention' ? MessageSquareWarning : Info
  return <article className={`subagent-notice subagent-notice--${view.tone}`} aria-label={view.title}
    data-supervisor-request={view.request?.requestId} tabIndex={-1}>
    <header className="subagent-notice__header">
      <span className="subagent-notice__icon"><Icon size={17} aria-hidden="true" /></span>
      <div><strong>{view.title}</strong><small>{view.request ? t('Supervisor channel · child → parent agent') : t('Subagents · recorded notification')}</small></div>
      <span className="subagent-notice__badge">{view.badge}</span>
    </header>
    {!view.nativeOnly && <div className="subagent-notice__body">
      {view.body && <><p className="subagent-notice__label">{view.request ? t('Request') : t('Message')}</p>
        <p id={bodyId} className={`subagent-notice__text ${expanded || !expandable ? '' : 'is-clamped'}`}>{view.body}</p>
        {expandable && <button className="subagent-notice__expand" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(!expanded)}>{expanded ? t('Show less') : view.request ? t('Show full request') : t('Show full message')}</button>}
      </>}
      {view.fields && <dl className="subagent-notice__fields">{view.fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>}
    </div>}
    <div className="subagent-notice__footer"><span>{view.footer}</span>
      {view.request?.expectsReply && onDraft && <button onClick={() => onDraft(view.request!)}>{t("Draft guidance to parent ↗")}</button>}
      {view.related?.filter(id => requestIds?.has(id)).map(id => <button key={id} onClick={() => onRequest?.(id)}>{t("View request ·") + ' '}{id.slice(0, 8)}</button>)}
    </div>
    <details className="subagent-notice__native" open={nativeOpen} onToggle={event => setNativeOpen(event.currentTarget.open)}>
      <summary>{t('Native details · IDs & original message')}</summary>
      {nativeOpen && <><p>{t("Bounded display only. Full original content remains in the Pi session.")}</p>
        <pre>{noticeText(message) || t('No text available.')}</pre>
        <pre>{noticeMetadata({ customType: message.customType, details: message.details })}</pre>
      </>}
    </details>
  </article>
}
