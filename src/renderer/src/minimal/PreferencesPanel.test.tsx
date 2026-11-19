// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PluginInventory } from '../../../../packages/shared/plugins'
import { PreferencesPanel } from './PreferencesPanel'
import { LanguageContext } from './language'
import { WorkspaceInfo } from './WorkspaceInfo'
import { PluginList } from './PluginList'
import { version } from '../../../../package.json'

const inventory: PluginInventory = {
  agentDir: '/agent', workspace: '/project', warnings: ['Unreadable configuration'],
  global: [
    { id: 'permissions', name: 'Permissions', scope: 'global', state: 'configured', source: 'npm:@gotgenes/pi-permission-system', adapted: 'permissions' },
    { id: 'todo', name: 'Todo', scope: 'global', state: 'disabled', source: 'npm:@juicesharp/rpiv-todo', adapted: 'todo' },
    { id: 'subagents', name: 'Subagents', scope: 'global', state: 'missing', source: 'npm:pi-subagents', adapted: 'subagents' }
  ],
  local: [{ id: 'local', name: 'Project plugin', source: '.pi/extensions/project.ts', scope: 'local', state: 'installed' }]
}
beforeEach(() => {
  // jsdom has no native dialog implementation. Browser modality is provided by showModal.
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); this.querySelector<HTMLButtonElement>('[autofocus]')?.focus() })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open') })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const defaults = () => ({ preferences: { workspaces: [], theme: 'system' as const, enterToSend: true }, runtime: '/actual/pi', onChange: vi.fn(), onClose: vi.fn(), loadPlugins: vi.fn().mockResolvedValue(inventory) })

it('PreferencesPanel uses category rail, drill-ins, bilingual preview and actual About values', async () => {
  const props = defaults()
  const view = render(<PreferencesPanel {...props} />)
  expect(screen.queryByText('Composer')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /^Theme/ }))
  const day = within(screen.getByRole('group', { name: 'Daytime' }))
  expect(day.getAllByRole('button')).toHaveLength(6)
  fireEvent.click(day.getByRole('button', { name: 'Paper' }))
  expect(props.onChange).toHaveBeenCalledWith({ dayTheme: 'paper' })
  fireEvent.click(within(screen.getByRole('group', { name: 'Nighttime' })).getByRole('button', { name: 'Moss Ink' }))
  expect(props.onChange).toHaveBeenCalledWith({ nightTheme: 'ocean' })
  fireEvent.click(screen.getByRole('button', { name: 'Fixed theme' }))
  expect(props.onChange).toHaveBeenCalledWith({ theme: 'light' })
  view.rerender(<PreferencesPanel {...props} preferences={{ ...props.preferences, theme: 'light' }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Dark' }))
  expect(props.onChange).toHaveBeenCalledWith({ theme: 'dark' })
  fireEvent.click(screen.getByLabelText('Back to Appearance'))
  fireEvent.click(screen.getByRole('button', { name: /Font Conversation/ }))
  expect(screen.getByLabelText('Font preview').textContent).toContain('给想法留一点空间。')
  fireEvent.click(screen.getByRole('button', { name: 'Serif' }))
  expect(props.onChange).toHaveBeenCalledWith({ font: 'serif' })
  fireEvent.click(screen.getByRole('button', { name: 'About' }))
  expect(screen.getByText('/actual/pi')).toBeTruthy()
  expect(screen.getByText(version)).toBeTruthy()
  expect(screen.getByText('Pi Studio', { exact: true })).toBeTruthy()
  expect(screen.getByText('Author:').nextElementSibling?.textContent).toBe('YM')
  const url = 'https://github.com/ymd-physics/pi-studio'
  expect(screen.getByRole('link', { name: url }).getAttribute('href')).toBe(url)
  expect(screen.getByText('Credits:').nextElementSibling?.textContent).toBe('Built with assistance from OpenAI’s GPT models. Powered by Pi.')
  expect(screen.getByText(/Recommended: Pi ≥ 1.4.0/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))
  expect(await screen.findByText('Permissions')).toBeTruthy()
  expect(screen.queryByText('Project plugin')).toBeNull()
})

it.each(['en', 'zh-CN'] as const)('keeps both font sample lines in the %s interface', async language => {
  const zh = language === 'zh-CN'
  render(<LanguageContext.Provider value={language}><PreferencesPanel {...defaults()} /></LanguageContext.Provider>)
  fireEvent.click(screen.getByRole('button', { name: zh ? /^字体/ : /^Font Conversation/ }))
  const preview = screen.getByLabelText(zh ? '字体预览' : 'Font preview')
  expect(preview.textContent).toBe('A little space to think.给想法留一点空间。')
  expect(preview.querySelectorAll('br')).toHaveLength(1)
  await act(async () => {})
})

it('PreferencesPanel opens natively, handles native Escape cancel and restores opener focus', async () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus()
  const props = defaults()
  const view = render(<PreferencesPanel {...props} />)
  expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce()
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  expect(props.onClose).toHaveBeenCalledOnce()
  await act(async () => {})
  view.unmount()
  expect(document.activeElement).toBe(opener)
  opener.remove()
})

it('WorkspaceInfo separates Local and Global, preserving warnings and honest states', async () => {
  render(<WorkspaceInfo workspace={{ name: 'Project', path: '/project' }} onClose={vi.fn()} onRename={vi.fn()} loadPlugins={defaults().loadPlugins} />)
  expect(await screen.findByText('Project plugin')).toBeTruthy()
  expect(screen.queryByText('Permissions')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Global/ }))
  expect(screen.getByText('Configured')).toBeTruthy()
  expect(screen.getByText('Disabled')).toBeTruthy()
  expect(screen.getByText('Recommended')).toBeTruthy()
  expect(screen.getAllByText('Studio adapted')).toHaveLength(3)
  expect(screen.getByRole('alert').textContent).toBe('Unreadable configuration')
})

it('renames inside WorkspaceInfo without hiding plugins and preserves errors for retry', async () => {
  const onRename = vi.fn().mockRejectedValueOnce(new Error('Save failed')).mockResolvedValue(undefined)
  render(<WorkspaceInfo workspace={{ name: 'Project', path: '/project' }} onClose={vi.fn()} onRename={onRename} loadPlugins={defaults().loadPlugins} />)
  await screen.findByText('Project plugin')
  fireEvent.click(screen.getByRole('button', { name: 'Rename workspace…' }))
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '  Physics  ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('Save failed')).toBeTruthy()
  expect(screen.getByText('Project plugin')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByRole('button', { name: 'Rename workspace…' })
  expect(onRename).toHaveBeenLastCalledWith('Physics')
  expect(screen.getByText('/project')).toBeTruthy()
})

it('shows plugin recommendation baselines and honest unknown installed versions', () => {
  render(<PluginList inventory={{ ...inventory, global: [{ id: 'web', name: 'pi-web-access', source: 'npm:pi-web-access', scope: 'global', state: 'installed', adapted: 'web-access', version: '0.47.0' }, ...inventory.global] }} scope="global" onRetry={vi.fn()} />)
  expect(screen.getByText(/Recommended: ≥ 0.47.0/)).toBeTruthy()
  expect(screen.getByText(/Installed: 0.47.0/)).toBeTruthy()
  expect(screen.getAllByText(/Version unknown/).length).toBeGreaterThan(0)
  expect(screen.getByText(/Older versions may have compatibility issues/)).toBeTruthy()
})

it('PluginList copies a recommendation without executing it and reports clipboard errors', async () => {
  const copyText = vi.fn().mockRejectedValue(new Error('denied'))
  Object.defineProperty(window, 'desktop', { configurable: true, value: { copyText } })
  render(<PluginList inventory={inventory} scope="global" onRetry={vi.fn()} />)
  fireEvent.click(screen.getByText('Installation instructions'))
  expect(screen.getByText('pi install npm:pi-subagents')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
  expect(await screen.findByText(/Could not copy command/)).toBeTruthy()
  expect(copyText).toHaveBeenCalledWith('pi install npm:pi-subagents')
})

it('PreferencesPanel retries failures and ignores stale inventory after a loader change', async () => {
  let resolve!: (value: PluginInventory) => void
  const stale = () => new Promise<PluginInventory>((done) => { resolve = done })
  const props = defaults()
  const view = render(<PreferencesPanel {...props} loadPlugins={stale} />)
  fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))
  expect(screen.getByRole('status').textContent).toBe('Reading plugins…')
  await act(async () => {})
  const fresh = vi.fn().mockRejectedValueOnce(new Error('read failed')).mockResolvedValue(inventory)
  view.rerender(<PreferencesPanel {...props} loadPlugins={fresh} />)
  expect(await screen.findByText(/Could not read plugins: read failed/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Permissions')).toBeTruthy()
  await act(async () => resolve({ global: [], local: [], agentDir: '/stale', warnings: [] }))
  expect(screen.getByText('Permissions')).toBeTruthy()
  expect(screen.queryByText(/Agent directory: \/stale/)).toBeNull()
})
