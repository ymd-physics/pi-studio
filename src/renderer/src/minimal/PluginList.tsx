import { useUiText } from './language'
import { useEffect, useState } from 'react'
import { formatPluginWarning, type PluginInventory } from '../../../../packages/shared/plugins'
import { PLUGIN_BASELINES } from '../../../../packages/shared/compatibility'

export function usePluginInventory(loadPlugins: () => Promise<PluginInventory>) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ inventory?: PluginInventory; error?: string }>({})
  useEffect(() => {
    let current = true
    setResult({})
    Promise.resolve().then(loadPlugins).then(
      (inventory) => { if (current) setResult({ inventory }) },
      (error: unknown) => { if (current) setResult({ error: error instanceof Error ? error.message : String(error) }) }
    )
    return () => { current = false }
  }, [loadPlugins, attempt])
  return { ...result, retry: () => setAttempt((value) => value + 1) }
}

export function PluginList({ inventory, scope, error, onRetry }: {
  inventory?: PluginInventory
  scope: 'global' | 'local'
  error?: string
  onRetry(): void
}) {
  const t = useUiText()
  const [copyStatus, setCopyStatus] = useState('')
  if (error !== undefined) return <div role="alert"><p>{t("Could not read plugins:") + ' '}{error}</p><button onClick={onRetry}>{t("Retry")}</button></div>
  if (!inventory) return <p role="status">{t("Reading plugins…")}</p>
  return <>
    <p className="pp-intro">{scope === 'global' ? t('Global Pi resources available across workspaces.') : t('Resources declared by this workspace.')}</p>
    {inventory.warnings.map((warning, index) => <p className="pp-warning" role="alert" key={index}>{formatPluginWarning(warning, t)}</p>)}
    {inventory[scope].length === 0 && <p>{t(scope === 'local' ? 'No local plugins found.' : 'No global plugins found.')}</p>}
    {inventory[scope].map((plugin) => {
      const command = plugin.state === 'missing' && plugin.adapted
        ? `pi install npm:${PLUGIN_BASELINES[plugin.adapted].package}${scope === 'local' ? ' -l' : ''}` : undefined
      return <article className="pp-plugin" key={plugin.id}>
        <div className="pp-plugin-top"><strong>{plugin.name}</strong>{plugin.adapted && <span className="pp-badge">{t("Studio adapted")}</span>}<span className={`pp-state${plugin.state === 'missing' && plugin.adapted ? ' pp-recommended' : ''}`}>{plugin.state === 'missing' && plugin.adapted ? t('Recommended') : t(plugin.state[0].toUpperCase() + plugin.state.slice(1))}</span></div>
        <div className="pp-path">{plugin.source}</div>
        {plugin.adapted && <p className="pp-plugin-version">{t("Recommended: ≥") + ' '}{PLUGIN_BASELINES[plugin.adapted].version}{plugin.state !== 'missing' && <span>{' ' + t("· Installed:") + ' '}{plugin.version || t('Version unknown')}</span>}</p>}
        {plugin.description && <p>{t(plugin.description)}</p>}
        {command && <details><summary>{t("Installation instructions")}</summary><div className="pp-instruction"><code>{command}</code><button onClick={async () => {
          try { await window.desktop.copyText(command); setCopyStatus('Command copied.') }
          catch { setCopyStatus('Could not copy command. Select and copy the text manually.') }
        }}>{t("Copy command")}</button><p>{t(scope === 'local' ? 'Run in terminal Pi from this workspace, then reload the session. Pi Studio does not run this command.' : 'Run in terminal Pi, then reload the session. Pi Studio does not run this command.')}</p></div></details>}
      </article>
    })}
    <p role="status">{t(copyStatus)}</p>
    <p className="pp-footnote">{t("Read-only inventory. Installed or configured does not mean enabled or loaded in a session. Manage plugins with native Pi. Studio-adapted plugins are optional, not bundled. Recommended versions are known adapter baselines, not a compatibility guarantee. Older versions may have compatibility issues.")}</p>
    <p className="pp-path">{t("Agent directory:") + ' '}{inventory.agentDir}</p>
  </>
}
