import { useUiText } from './language'
import { useState } from 'react'
import { X } from 'lucide-react'
import type { Workspace } from '../../../../packages/shared/desktop'
import type { PluginInventory } from '../../../../packages/shared/plugins'
import { PreferencesDialog } from './PreferencesPanel'
import { PluginList, usePluginInventory } from './PluginList'

export interface WorkspaceInfoProps {
  workspace: Workspace
  onClose(): void
  onPin?(pinned: boolean): Promise<void>
  pinLimitReached?: boolean
  onRename(name: string): Promise<void>
  loadPlugins(): Promise<PluginInventory>
}

export function WorkspaceInfo(props: WorkspaceInfoProps) {
  // Remount inventory state when the selected workspace changes.
  return <WorkspaceInfoContent key={props.workspace.path} {...props} />
}

function WorkspaceInfoContent({ workspace, onClose, onRename, onPin, pinLimitReached, loadPlugins }: WorkspaceInfoProps) {
  const t = useUiText()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(workspace.name)
  const [saving, setSaving] = useState(false)
  const [renameError, setRenameError] = useState('')
  const saveName = async (event: React.FormEvent) => {
    event.preventDefault()
    if (saving || !name.trim()) return
    setSaving(true); setRenameError('')
    try { await onRename(name.trim()); setEditing(false) }
    catch (error) { setRenameError(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  const [scope, setScope] = useState<'local' | 'global'>('local')
  const { inventory, error, retry } = usePluginInventory(loadPlugins)
  return <PreferencesDialog label={t("Workspace information")} onClose={onClose} workspace>
    <section className="pp-content">
      <header className="pp-heading"><h2>{t("Workspace information")}<small>{workspace.name}</small></h2><button autoFocus aria-label={t("Close workspace information")} onClick={onClose}><X size={17} /></button></header>
      <div className="pp-body">
        <div className="pp-workspace-identity">
          {editing ? <form onSubmit={(event) => void saveName(event)}>
            <label htmlFor="workspace-display-name">{t("Display name")}</label>
            <input id="workspace-display-name" autoFocus value={name} disabled={saving} maxLength={160} onChange={(event) => setName(event.target.value)} />
            <p className="pp-footnote">{t("Only the display name changes. Your folder, sessions and terminal paths stay the same.")}</p>
            {renameError && <p role="alert" className="error-text">{renameError}</p>}
            <div className="pp-rename-actions"><button type="button" disabled={saving} onClick={() => setEditing(false)}>{t("Cancel")}</button><button type="submit" disabled={saving || !name.trim()}>{saving ? t('Saving…') : t('Save')}</button></div>
          </form> : <button className="pp-rename-workspace" onClick={() => { setName(workspace.name); setRenameError(''); setEditing(true) }}>{t("Rename workspace…")}</button>}
          {!editing && onPin && <><button className="pp-rename-workspace" disabled={saving || (!workspace.pinned && pinLimitReached)} onClick={async () => {
            setSaving(true); setRenameError(''); try { await onPin(!workspace.pinned) } catch (e) { setRenameError(String(e)) } finally { setSaving(false) }
          }}>{t(workspace.pinned ? 'Unpin workspace' : 'Pin workspace')}</button>
            {!workspace.pinned && pinLimitReached && <p className="pp-footnote">{t('Up to five workspaces can be pinned')}</p>}
            {renameError && <p role="alert">{renameError}</p>}</>}
          <p className="pp-path">{workspace.path}</p>
        </div>
        <div className="pp-scopes" aria-label={t("Plugin scope")}>{(['local', 'global'] as const).map((value) => <button key={value} aria-pressed={scope === value} onClick={() => setScope(value)}>{value === 'local' ? t('Local') : t('Global')}{inventory && <small> {inventory[value].length}</small>}</button>)}</div>
        <PluginList key={scope} inventory={inventory} error={error} scope={scope} onRetry={retry} />
      </div>
    </section>
  </PreferencesDialog>
}
