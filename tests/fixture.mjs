import { mkdtemp, mkdir, writeFile, rm, realpath, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'

// Deterministic HTTP provider for tests ONLY. Pi still owns prompts, sessions,
// extensions, tool execution, cancellation, and serialization end to end.
export async function createFixture({ completion } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-desktop-test-')))
  const agentDir = join(root, 'agent'),
    workspace = join(root, 'research'),
    dataDir = join(root, 'desktop')
  await Promise.all([
    mkdir(join(agentDir, 'extensions'), { recursive: true }),
    mkdir(join(agentDir, 'skills/demo'), { recursive: true }),
    mkdir(join(agentDir, 'prompts'), { recursive: true }),
    mkdir(workspace),
    mkdir(dataDir),
  ])
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const lastUser = body.messages?.filter((m) => m.role === 'user').at(-1)
    const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content)
    const last = body.messages?.at(-1)
    let delta,
      reason = 'stop'
    const override = completion?.(body)
    if (override) {
      delta = override.delta
      reason = override.reason || 'stop'
    } else if (/seed real todo/i.test(text || '') && last?.role !== 'tool') {
      delta = {
        tool_calls: [
          {
            index: 0,
            id: 'todo-create',
            type: 'function',
            function: {
              name: 'todo',
              arguments: JSON.stringify({
                action: 'create',
                tasks: [{ subject: 'Derive the oscillator spectrum' }, { subject: 'Check units' }],
              }),
            },
          },
        ],
      }
      reason = 'tool_calls'
    } else if (/seed real todo/i.test(text || '') && last?.tool_call_id === 'todo-create') {
      delta = {
        tool_calls: [
          {
            index: 0,
            id: 'todo-dependency',
            type: 'function',
            function: {
              name: 'todo',
              arguments: JSON.stringify({ action: 'update', id: 2, addBlockedBy: [1] }),
            },
          },
          {
            index: 1,
            id: 'todo-complete',
            type: 'function',
            function: {
              name: 'todo',
              arguments: JSON.stringify({ action: 'update', id: 1, status: 'completed' }),
            },
          },
        ],
      }
      reason = 'tool_calls'
    } else if (/grouped tools/i.test(text || '') && last?.role !== 'tool') {
      delta = {
        tool_calls: [
          {
            index: 0,
            id: 'group-a-' + requests.length,
            type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 2; printf grouped-ok' }) },
          },
          {
            index: 1,
            id: 'group-b-' + requests.length,
            type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({ command: 'exit 2' }) },
          },
          {
            index: 2,
            id: 'group-c-' + requests.length,
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ path: 'notes.md' }) },
          },
        ],
      }
      reason = 'tool_calls'
    } else if (/run tool|slow tool|large tool|owned process/i.test(text || '') && last?.role !== 'tool') {
      delta = {
        tool_calls: [
          {
            index: 0,
            id: 'test-call-' + requests.length,
            type: 'function',
            function: {
              name: 'bash',
              arguments: JSON.stringify({
                command: /owned process/i.test(text)
                  ? `printf '%s %s' "$$" "$PPID" > owned-${/second/i.test(text) ? 'second' : 'first'}.pid; sleep 60`
                  : /slow tool/i.test(text)
                    ? 'sleep 30'
                    : /large tool/i.test(text)
                      ? "printf '%040000d' 0"
                      : 'printf native-tool-ok',
              }),
            },
          },
        ],
      }
      reason = 'tool_calls'
    } else {
      delta = {
        content:
          last?.role === 'tool'
            ? 'Native tool finished.\n\n' + last.content
            : '# A quiet place for ideas\n\nThe **native Pi session** is connected.\n\nFor a harmonic oscillator, $E_n=\\hbar\\omega(n+\\frac12)$.\n\n\\[\\int_0^\\infty e^{-x^2}\\,dx=\\frac{\\sqrt{\\pi}}2\\]\n\n```python\nimport numpy as np\nenergy = hbar * omega * (n + 0.5)\n```\n\n| Quantity | Meaning |\n| --- | --- |\n| $\\omega$ | Angular frequency |\n| $n$ | Quantum number |',
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const event = (choices) =>
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'test-response',
            object: 'chat.completion.chunk',
            created: 1,
            model: body.model,
            choices,
            ...(choices.length === 0
              ? { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }
              : {}),
          }) +
          '\n\n',
      )
    event([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])
    event([
      {
        index: 0,
        delta: { reasoning_content: 'Consider the native session context before answering.' },
        finish_reason: null,
      },
    ])
    if (/grouped tools/i.test(text || '') && last?.role !== 'tool')
      await new Promise((resolve) => setTimeout(resolve, 1600))
    event([{ index: 0, delta, finish_reason: null }])
    event([{ index: 0, delta: {}, finish_reason: reason }])
    event([])
    res.end('data: [DONE]\n\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'desktop-test': {
          baseUrl,
          apiKey: 'test-only',
          api: 'openai-completions',
          models: ['test-model', 'second-model'].map((id) => ({
            id,
            name: id,
            reasoning: true,
            input: ['text'],
            contextWindow: 128000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: { supportsDeveloperRole: false, supportsStore: false, supportsUsageInStreaming: true },
          })),
        },
      },
    }),
  )
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'desktop-test',
      defaultModel: 'test-model',
      defaultThinkingLevel: 'off',
      defaultTools: ['read', 'bash', 'edit', 'write'],
      enableSkillCommands: true,
      packages: [],
      compaction: { enabled: true, keepRecentTokens: 128, reserveTokens: 1024 },
    }),
  )
  await writeFile(
    join(agentDir, 'extensions/check.ts'),
    `export default function(pi) {
    pi.registerCommand('desktop-switch', { description: 'Test native session-switch guard', handler: async (args, ctx) => { await ctx.switchSession(args); }});
    pi.registerCommand('long-history', { description: 'Generate isolated long-history fixture', handler: async () => {
      for (let i = 0; i < 140; i++) pi.sendMessage({ customType: 'test', content: 'History item ' + i, display: true });
    }});
    pi.registerCommand('desktop-check', { description: 'Test extension command', handler: async (_args, ctx) => {
      const answer = await ctx.ui.select('Choose a test option', ['Alpha', 'Beta']);
      ctx.ui.notify('Selected: ' + answer, 'info');
      ctx.ui.setStatus('test', 'Extension ready');
      ctx.ui.setWidget('test-widget', ['Native extension widget']);
      ctx.ui.setEditorText('Extension replied');
    }});
  }`,
  )
  await writeFile(
    join(agentDir, 'skills/demo/SKILL.md'),
    '---\nname: demo\ndescription: Isolated desktop test skill\n---\nRespond concisely.\n',
  )
  await writeFile(
    join(agentDir, 'prompts/explain.md'),
    '---\ndescription: Explain a concept\n---\nExplain $@.\n',
  )
  await writeFile(join(workspace, 'notes.md'), '# Research notes\n\n$E = mc^2$\n')
  await writeFile(join(workspace, 'example.py'), 'print("hello")\n')
  await writeFile(
    join(dataDir, 'preferences.json'),
    JSON.stringify({
      workspaces: [{ path: workspace, name: 'Research' }],
      activeWorkspace: workspace,
      theme: 'light',
      enterToSend: true,
    }),
  )
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_DESKTOP_DATA_DIR: dataDir }
  // Seed history with the real terminal CLI, not handcrafted JSONL.
  const terminal = (args) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        process.env.PI_DESKTOP_TEST_PI || 'pi',
        args,
        { cwd: workspace, env, timeout: 30000, maxBuffer: 5 * 1024 * 1024 },
        (error, stdout, stderr) =>
          error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
      )
      child.stdin.end()
    })
  await terminal(['--mode', 'json', '-p', 'Discuss the harmonic oscillator']).catch(async (error) => {
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
    throw error
  })
  const session = (await readdir(join(agentDir, 'sessions'), { recursive: true })).find((path) =>
    path.endsWith('.jsonl'),
  )
  await writeFile(
    join(dataDir, 'preferences.json'),
    JSON.stringify({
      workspaces: [{ path: workspace, name: 'Research' }],
      activeWorkspace: workspace,
      activeSession: join(agentDir, 'sessions', session),
      theme: 'light',
      enterToSend: true,
    }),
  )
  return {
    root,
    agentDir,
    workspace,
    dataDir,
    env,
    requests,
    terminal,
    async dispose() {
      await new Promise((resolve) => server.close(resolve))
      await rm(root, { recursive: true, force: true })
    },
  }
}
