import { useUiText } from './language'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Info, Monitor, PanelsTopLeft, X } from 'lucide-react'
import { version as appVersion } from '../../../../package.json'
import type { Preferences } from '../../../../packages/shared/desktop'
import type { PluginInventory } from '../../../../packages/shared/plugins'
import { PI_RECOMMENDED_VERSION } from '../../../../packages/shared/compatibility'
import { PluginList, usePluginInventory } from './PluginList'
import './preferences-panel.css'

export function PreferencesDialog({ children, label, onClose, workspace = false }: {
  children: ReactNode; label: string; onClose(): void; workspace?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const opener = useRef(document.activeElement)
  useEffect(() => {
    const previous = opener.current
    const dialog = ref.current!
    dialog.showModal()
    return () => {
      dialog.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return <dialog ref={ref} className={`pp-dialog${workspace ? ' pp-workspace' : ''}`} aria-label={label}
    onCancel={(event) => { event.preventDefault(); onClose() }}>
    {children}
  </dialog>
}

export interface PreferencesPanelProps {
  preferences: Preferences
  runtime: string
  onChange(patch: Partial<Pick<Preferences, 'theme' | 'font' | 'enterToSend' | 'language'>>): void
  onClose(): void
  loadPlugins(): Promise<PluginInventory>
}

export function PreferencesPanel({ preferences, runtime, onChange, onClose, loadPlugins }: PreferencesPanelProps) {
  const t = useUiText()
  const [category, setCategory] = useState<'Appearance' | 'Plugins' | 'About'>('Appearance')
  const [detail, setDetail] = useState<'Theme' | 'Font' | 'Language' | null>(null)
  const { inventory, error, retry } = usePluginInventory(loadPlugins)
  const heading = useRef<HTMLHeadingElement>(null)
  const navigate = (next: typeof detail) => { setDetail(next); requestAnimationFrame(() => heading.current?.focus()) }
  return <PreferencesDialog label={t("Preferences")} onClose={onClose}>
    <nav className="pp-rail" aria-label={t("Preferences categories")}>
      <h2>{t("Preferences")}</h2>
      {([['Appearance', Monitor], ['Plugins', PanelsTopLeft], ['About', Info]] as const).map(([name, Icon]) =>
        <button key={name} aria-current={category === name ? 'page' : undefined} onClick={() => { setCategory(name); setDetail(null) }}><Icon size={15} />{t(name)}</button>)}
      <p className="pp-rail-foot">Pi Studio {appVersion}<br />{t("Your Pi. Your configuration.")}</p>
    </nav>
    <section className="pp-content">
      <header className="pp-heading">
        {detail && <button aria-label={t("Back to Appearance")} onClick={() => navigate(null)}><ArrowLeft size={16} /></button>}
        <h2 ref={heading} tabIndex={-1}>{t(detail || category)}</h2>
        <button autoFocus aria-label={t("Close preferences")} onClick={onClose}><X size={17} /></button>
      </header>
      <div className="pp-body">
        {category === 'Appearance' && !detail && <>
          <p className="pp-intro">{t("Make space for comfortable reading.")}</p>
          <div className="pp-group">{([
            ['Theme', 'Light, dark or system appearance', preferences.theme],
            ['Font', 'Conversation typography', preferences.font || 'default'],
            ['Language', 'Interface language', preferences.language === 'zh-CN' ? '简体中文' : 'English'],
          ] as const).map(([name, description, value]) => (
            <button className="pp-row" key={name} onClick={() => navigate(name)}>
              <span><strong>{t(name)}</strong><small>{t(description)}</small></span>
              <span>{t(value[0].toUpperCase() + value.slice(1))} ›</span>
            </button>
          ))}</div>
        </>}
        {detail === 'Language' && <>
          <p className="pp-intro">{t('Choose the language used in Pi Studio.')}</p>
          {([['en', 'English'], ['zh-CN', '简体中文']] as const).map(([language, label]) => (
            <button key={language} className="pp-choice" lang={language} aria-pressed={(preferences.language || 'en') === language} onClick={() => onChange({ language })}>{label}</button>
          ))}
        </>}
        {detail === 'Theme' && <><p className="pp-intro">{t("Choose the appearance of Pi Studio. System follows your system appearance.")}</p><div className="pp-theme-grid">{(['light', 'dark', 'system'] as const).map((theme) => <button className="pp-theme-choice" aria-pressed={preferences.theme === theme} key={theme} onClick={() => onChange({ theme })}><span className={`pp-mini pp-mini-${theme}`} aria-hidden="true"><i /><b /></span>{t(theme[0].toUpperCase() + theme.slice(1))}</button>)}</div></>}
        {detail === 'Font' && <><p className="pp-intro">{t("Choose a font for conversation text. Interface, code and mathematics retain their own fonts.")}</p>{(['default', 'serif'] as const).map((font) => <button className="pp-choice" aria-pressed={(preferences.font || 'default') === font} key={font} onClick={() => onChange({ font })}>{font === 'default' ? t('Default') : t('Serif')}</button>)}<div className={`pp-font-preview ${preferences.font === 'serif' ? 'pp-serif' : ''}`} aria-label={t("Font preview")}>{t("A little space to think.")}<br />给想法留一点空间。</div></>}
        {category === 'Plugins' && <><p className="pp-intro">{t("Workspace-local resources are shown in workspace information, not here.")}</p><PluginList inventory={inventory} error={error} scope="global" onRetry={retry} /></>}
        {category === 'About' && <>
          <p className="pp-intro">{t("A workspace for thinking, coding, and research.")}</p>
          <h3>{t("Application")}</h3><div className="pp-group"><div className="pp-row"><strong>Pi Studio</strong><span>{appVersion}</span></div></div>
          <div className="pp-about-credit"><strong>{t("Developed by YM")}</strong><p>{t("Built with assistance from OpenAI’s GPT models.")}</p><p>{t("Powered by Pi.")}</p></div>
          <h3>{t("Pi installation")}</h3><div className="pp-group"><div className="pp-row"><span><strong>{t("Installed Pi")}</strong><small className="pp-path">{runtime || t('Installation unavailable')}</small></span></div></div>
          <p className="pp-footnote">{t("Recommended: Pi ≥") + ' '}{PI_RECOMMENDED_VERSION}{t(". Older versions may have compatibility issues.")}</p>
          <p className="pp-footnote">{t("Optional plugin baselines are listed under Plugins and Workspace information. These are known adapter baselines, not a guarantee for every version.")}</p>
          <p className="pp-footnote">{t("Models, authentication, plugins and skills remain managed by native Pi.")}</p>
        </>}
      </div>
    </section>
  </PreferencesDialog>
}
