import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFixture } from './fixture.mjs'

const plugin = process.env.PI_DESKTOP_TEST_SUBAGENTS
const tool = (name, args, id = name) => ({
  delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
  reason: 'tool_calls',
})
const textOf = (m) => typeof m?.content === 'string' ? m.content : (m?.content || []).map(b => b.text || '').join('\n')

test('real pi-subagents shares the host SDK and executes foreground/background children', async () => {
  test.skip(!plugin, 'Set PI_DESKTOP_TEST_SUBAGENTS to the installed pi-subagents/index.js')
  test.setTimeout(90000)
  const fixture = await createFixture({ completion: (body) => {
    const last = body.messages.at(-1)
    const user = textOf(body.messages.filter(m => m.role === 'user').at(-1))
    if (user.includes('Subagent needs a supervisor decision')) {
      const replyTo = user.match(/replyTo:\s*"([^"]+)"/)?.[1]
      if (replyTo && last.role !== 'tool') return tool('subagent_supervisor', { action: 'reply', replyTo, message: 'Approved: read only the isolated notes.md fixture.' }, 'reply-supervisor')
    }
    if (user.includes('DESKTOP_CHILD_HOLD') && last.role !== 'tool')
      return tool('bash', { command: 'printf "%s %s" "$$" "$PPID" > subagent-owned.pid; sleep 60' }, 'child-hold')
    if (user.includes('DESKTOP_DELEGATE_hold') && last.role !== 'tool')
      return tool('subagent', { agent: 'desktop-probe', task: 'DESKTOP_CHILD_HOLD', async: true, output: false, options: { timeoutMs: 60000 } }, 'delegate-hold')
    if (user.includes('DESKTOP_CHILD_CHECK')) {
      if (user.includes('DESKTOP_CHILD_CHECK_background') && last.role !== 'tool')
        return tool('contact_supervisor', { reason: 'need_decision', message: 'May I read the isolated notes.md fixture?' }, 'child-ask')
      const mode = user.match(/DESKTOP_CHILD_CHECK_(foreground|background|workflow)/)?.[1]
      return last.tool_call_id === 'child-read'
        ? { delta: { content: 'DESKTOP_CHILD_SUCCESS_' + mode + ': ' + textOf(last) } }
        : tool('read', { path: 'notes.md' }, 'child-read')
    }
    const mode = user.match(/DESKTOP_DELEGATE_(foreground|background|workflow)/)?.[1]
    if (mode === 'workflow' && last.role !== 'tool') return tool('subagent', { workflow: 'parallel', args: { tasks: [1, 2].map(i => ({ agent: 'desktop-probe', task: 'DESKTOP_CHILD_CHECK_workflow: read notes.md, task ' + i })) }, async: true, output: false, options: { timeoutMs: 20000 } }, 'delegate-workflow')
    if (mode && last.role !== 'tool') {
      const names = body.tools?.map(t => t.function.name) || []
      if (!names.includes('subagent')) return tool('subagents_enable', {}, 'enable-delegation')
      return tool('subagent', { agent: 'desktop-probe', task: 'DESKTOP_CHILD_CHECK_' + mode + ': read notes.md and report.', async: mode === 'background', output: false, options: { timeoutMs: 15000 } }, 'delegate-' + mode)
    }
    if (mode && last.tool_call_id === 'enable-delegation')
      return tool('subagent', { agent: 'desktop-probe', task: 'DESKTOP_CHILD_CHECK_' + mode + ': read notes.md and report.', async: mode === 'background', output: false, options: { timeoutMs: 15000 } }, 'delegate-' + mode)
    return undefined
  } })
  let app
  let ownedPids = []
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  try {
    const root = dirname(plugin)
    await mkdir(join(fixture.agentDir, 'extensions/subagent'), { recursive: true })
    await mkdir(join(fixture.agentDir, 'agents'), { recursive: true })
    await writeFile(join(fixture.agentDir, 'extensions/subagent/config.json'), JSON.stringify({ toolActivation: 'dynamic', forceTopLevelAsync: false, asyncByDefault: false }))
    await writeFile(join(fixture.agentDir, 'agents/desktop-probe.md'), `---\nname: desktop-probe\ndescription: Isolated native desktop compatibility probe\ntools: read, bash, contact_supervisor\nmodel: desktop-test/test-model\nthinking: off\n---\nRead only the requested fixture file and report its contents.\n`)
    const settingsPath = join(fixture.agentDir, 'settings.json')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    settings.extensions = [plugin]
    await writeFile(settingsPath, JSON.stringify(settings))
    // This diagnostic uses the plugin's actual resolver, not an emulated host check.
    await writeFile(join(fixture.agentDir, 'extensions/subagent-host.ts'), `
      import {resolveHostPiPackageRoot,resolvePiCliScript} from ${JSON.stringify(pathToFileURL(join(root, 'src/runs/shared/pi-spawn.js')).href)};
      export default function(pi) { pi.registerCommand('subagent-host', {handler: async (_, ctx) => {
        ctx.ui.notify('Subagent host: '+JSON.stringify({root:resolveHostPiPackageRoot(),cli:resolvePiCliScript()}),'info');
      }}); }
    `)
    app = await electron.launch({
      args: process.env.PI_DESKTOP_TEST_EXECUTABLE ? [] : ['.'],
      executablePath: process.env.PI_DESKTOP_TEST_EXECUTABLE,
      env: { ...fixture.env, PI_SUBAGENTS_TEMP_ROOT: join(fixture.root, 'subagents-temp'),
        // A stale inherited host must never redirect children to another installation.
        PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: join(fixture.root, 'wrong-sdk') },
    })
    const page = await app.firstWindow()
    const input = page.getByRole('textbox', { name: 'Message Pi' })
    await expect(input).toBeVisible()
    await input.fill('/subagent-host')
    await input.press('Enter')
    await expect(page.locator('.session-notice').filter({ hasText: /Subagent host:.*pi-coding-agent.*cli/ })).toBeVisible()
    const snapshot = () => page.evaluate(() => window.desktop.snapshot())
    const results = async () => (await snapshot()).messages.filter(m => m.role === 'toolResult' && m.toolName === 'subagent')
    for (const mode of ['foreground', 'background', 'workflow']) {
      await input.fill('DESKTOP_DELEGATE_' + mode)
      await input.press('Enter')
      await expect.poll(async () => (await results()).some(m => m.toolCallId === 'delegate-' + mode), { timeout: 45000 }).toBe(true)
      const result = (await results()).find(m => m.toolCallId === 'delegate-' + mode)
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      expect(JSON.stringify(result)).not.toMatch(/neither is available|Failed to start|invalid host SDK/)
      if (mode === 'foreground') expect(JSON.stringify(result)).toContain('DESKTOP_CHILD_SUCCESS_foreground')
      else {
        expect(result.details.asyncId).toBeTruthy()
        await expect.poll(async () => (await snapshot()).messages.some(m => JSON.stringify(m).includes('DESKTOP_CHILD_SUCCESS_' + mode)), { timeout: 45000 }).toBe(true)
      }
      if (mode === 'background') {
        const request = page.getByRole('article', { name: 'desktop-probe needs a decision' })
        await expect(request).toContainText('May I read the isolated notes.md fixture?')
        await expect(request).not.toContainText('Reply with:')
        await expect(request).toContainText('current resolution not inferred')
      }
      await expect.poll(async () => (await snapshot()).subagents?.availability, { timeout: 10000 }).toBe('available')
      await writeFile('test-results/subagents-status-debug.json', JSON.stringify({ mode, result, status: (await snapshot()).subagents }, null, 2))
      await expect.poll(async () => (await snapshot()).subagents?.agents.some(a => a.name === 'desktop-probe' && a.state === 'complete'), { timeout: 10000 }).toBe(true)
      if (mode === 'foreground') {
        const card = (await snapshot()).subagents.agents.find(a => a.id.startsWith('foreground:'))
        expect(card.model).toContain('test-model')
        expect(card.thinking).toBe('off')
        expect(card.task).toContain('DESKTOP_CHILD_CHECK_foreground')
        await expect(page.getByRole('region', { name: 'Subagent activity' })).toBeVisible()
      }
      await expect(page.locator('.session-link.selected')).toHaveAttribute('data-status', 'active', { timeout: 45000 })
    }
    expect((await snapshot()).messages.some(m => m.role === 'toolResult' && m.toolName === 'subagent_supervisor' && !m.isError)).toBe(true)
    // All four children reached the isolated provider and native read tool.
    expect(fixture.requests.filter(body => body.messages.some(m => m.role === 'tool' && textOf(m).includes('Research notes'))).length).toBeGreaterThanOrEqual(4)
    await input.fill('/reload')
    await input.press('Enter')
    await expect(page.locator('.session-notice').filter({ hasText: 'Pi resources reloaded' })).toBeVisible()
    await input.fill('DESKTOP_DELEGATE_hold')
    await input.press('Enter')
    await expect.poll(async () => {
      try { return await readFile(join(fixture.workspace, 'subagent-owned.pid'), 'utf8') } catch { return '' }
    }).toMatch(/^\d+ \d+$/)
    ownedPids = (await readFile(join(fixture.workspace, 'subagent-owned.pid'), 'utf8')).trim().split(' ').map(Number)
    await expect(page.locator('.session-link.selected')).toHaveAttribute('data-status', 'active')
    await expect.poll(async () => (await snapshot()).subagents?.agents.some(a => a.state === 'running' && a.model?.includes('test-model')), { timeout: 10000 }).toBe(true)
    await expect(page.locator('.subagent-focus')).toBeVisible()
    await page.screenshot({ path: 'test-results/subagent-focus-native.png' })
    await app.evaluate(({ dialog, BrowserWindow }) => {
      dialog.showMessageBox = async () => ({ response: 0 })
      BrowserWindow.getAllWindows()[0].close()
    })
    await expect(input).toBeVisible()
    expect(ownedPids.every(alive)).toBe(true)
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }) })
    const closed = app.waitForEvent('close', { timeout: 20000 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await closed
    app = undefined
    await expect.poll(() => ownedPids.some(alive), { timeout: 10000 }).toBe(false)
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {})
      await app.close().catch(() => {})
    }
    for (const pid of ownedPids) { if (alive(pid)) { try { process.kill(pid, 'SIGTERM') } catch {} } }
    await fixture.dispose()
  }
})
