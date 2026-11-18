import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { UpdateInfo } from '../../../../packages/shared/updates'
import { useUiText } from './language'

export function UpdateCard({ version }: { version: string }) {
  const t = useUiText()
  const [state, setState] = useState<'idle' | 'checking' | 'error' | UpdateInfo>('idle')
  const [download, setDownload] = useState<'idle' | 'busy' | 'saved' | 'error'>('idle')
  const [expanded, setExpanded] = useState(false)
  const release = typeof state === 'object' && state.status === 'available' ? state : undefined
  async function check() {
    setState('checking'); setExpanded(false); setDownload('idle')
    try { setState(await window.desktop.checkUpdate()) } catch { setState('error') }
  }
  async function save() {
    if (!release) return
    setDownload('busy')
    try { setDownload(await window.desktop.downloadUpdate(release.version) === 'saved' ? 'saved' : 'idle') }
    catch { setDownload('error') }
  }
  return <div className="pp-group pp-update">
    <div className="pp-row"><span><strong>Pi Studio</strong> <span>{version}</span></span>
      <button disabled={state === 'checking' || download === 'busy'} onClick={check}>{t(state === 'checking' ? 'Checking…' : state === 'error' ? 'Retry' : 'Check for Updates')}</button></div>
    {state !== 'idle' && state !== 'checking' && <div className="pp-update-result">
      <div className="pp-update-status"><strong role="status">{release ? t('Version {version} is available', { version: release.version }) : t(state === 'error' ? 'Couldn’t check for updates. Try again later.' : 'You’re up to date.')}</strong>
      {release?.dmg && <button className="pp-download" disabled={download === 'busy'} onClick={save}>{t(download === 'busy' ? 'Downloading…' : 'Download DMG')}</button>}</div>
      {release && <>
        {!release.dmg && <small>{t('No compatible DMG is available for this computer.')}</small>}
        {download === 'saved' && <small role="status">{t('DMG saved. Open it to install the update.')}</small>}
        {download === 'error' && <small role="alert">{t('Couldn’t save or verify the DMG. Please retry.')}</small>}
        <button className="pp-notes-toggle" aria-expanded={expanded} aria-controls="release-notes" onClick={() => setExpanded(!expanded)}>{t(expanded ? 'Hide Release Notes' : 'Release Notes')}</button>
        <div className="pp-release-notes" id="release-notes" hidden={!expanded}>{expanded && (release.notes.trim() ? <ReactMarkdown skipHtml allowedElements={['p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'br', 'blockquote']} unwrapDisallowed>{release.notes}</ReactMarkdown> : t('No release notes were provided.'))}</div>
      </>}
    </div>}
  </div>
}
