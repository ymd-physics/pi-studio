// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Markdown, CodeBlock } from './Markdown'
import { preprocessMarkdownMath } from '../features/timeline/markdown-math-preprocess'

vi.mock('../lib/shiki-highlighter', () => ({ highlightCodeToHtml: vi.fn(async () => '') }))
afterEach(cleanup)

describe('preprocessMarkdownMath', () => {
  it('preserves fenced code, real closing fences, indented code and multiline spans verbatim', () => {
    const source = '```latex\r\n\\[x\\] $5\r\n```not-a-close\r\n\\(y\\)\r\n```\r\n'
    expect(preprocessMarkdownMath(source, { streaming: true })).toBe(source)
    for (const code of [
      '    \\(x\\) $5',
      '``one ` \\(x\\)\n$5``',
      '~~~tex\n\\[x\\]\n~~~',
      '> ```tex\n> \\(x\\)\n> ```',
    ]) {
      expect(preprocessMarkdownMath(code)).toBe(code)
    }
  })

  it('converts complete delimiters and bare environments without nesting display wrappers', () => {
    expect(preprocessMarkdownMath(String.raw`\(x\)`)).toBe('$x$')
    expect(preprocessMarkdownMath(String.raw`  \[ x^2 \]`)).toBe('  $$\n  x^2\n  $$')
    const environment = String.raw`\begin{align*}x&=1\end{align*}`
    expect(preprocessMarkdownMath(environment)).toBe(`$$\n${environment}\n$$`)
    expect(preprocessMarkdownMath(`\\[${environment}\\]`)).toBe(`$$\n${environment}\n$$`)
    expect(preprocessMarkdownMath(`$$\n${environment}\n$$`)).toBe(`$$\n${environment}\n$$`)
  })

  it('does not guess incomplete math or change currency into formulas', () => {
    for (const source of [String.raw`\[ x`, String.raw`\(x`, String.raw`\begin{align*}x`, '$$x']) {
      expect(preprocessMarkdownMath(source, { streaming: true })).toBe(source)
    }
    expect(preprocessMarkdownMath('cost $5 and $10')).toBe('cost \\$5 and \\$10')
    expect(preprocessMarkdownMath('$是合理的$')).toBe('\\$是合理的\\$')
  })
})

describe('Markdown', () => {
  it('preserves completed code DOM and copy state while trailing text streams', async () => {
    window.desktop = { copyText: vi.fn().mockResolvedValue(undefined) } as any
    const prefix = '```python\nx = 1\n```\n\n'
    const view = render(<Markdown text={prefix + 'first'} />)
    const block = view.container.querySelector('.code-block')
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await screen.findByRole('button', { name: 'Copied' })
    view.rerender(<Markdown text={prefix + 'first second'} />)
    expect(view.container.querySelector('.code-block')).toBe(block)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
  })
  it('renders GFM and all math forms', () => {
    const { container } = render(
      <Markdown
        text={
          '~~removed~~\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n$x$ and \\(y\\)\n\n\\[z\\]\n\n\\begin{equation}a=1\\end{equation}'
        }
      />,
    )
    expect(container.querySelector('del')?.textContent).toBe('removed')
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelectorAll('.katex')).toHaveLength(4)
  })

  it('copies unexpanded display LaTeX, not rendered text or inline math', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    window.desktop = { copyText: writeText } as any
    const source = String.raw`\begin{align*}E&=mc^2\\x&=\RR\end{align*}`
    const { container } = render(<Markdown text={`$x$\n\n\\[${source}\\]`} />)
    expect(container.querySelectorAll('.display-equation')).toHaveLength(1)
    expect(container.querySelectorAll('.katex')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Copy LaTeX' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(source))
    expect(screen.getByRole('button', { name: 'LaTeX copied' })).toBeTruthy()
  })

  it('keeps all fenced math/tex/latex as code', () => {
    const { container } = render(
      <Markdown text={'```math\nx^2\n```\n\n```latex\n\\(x\\)\n```\n\n```tex\n\\[x\\]\n```'} />,
    )
    expect(container.querySelectorAll('.code-block')).toHaveLength(3)
    expect(container.querySelectorAll('.katex')).toHaveLength(0)
    expect(container.querySelector('pre code')?.textContent).toBe('x^2\n')
  })

  it('scopes macros per message and disables trusted TeX HTML commands', () => {
    const { container, rerender } = render(<Markdown text={String.raw`$\gdef\local{z}\local$ $\local$`} />)
    expect(container.querySelectorAll('.katex')).toHaveLength(2)
    expect(container.querySelector('[style*="#cc0000"]')).toBeNull()
    rerender(<Markdown text={String.raw`$\local$ $\href{javascript:alert(1)}{unsafe}$`} />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('.katex-html')?.textContent).toContain('\\local')
  })

  it('does not load images, render raw HTML or emit unsafe links', () => {
    const { container } = render(
      <Markdown
        text={
          '![remote](https://example.com/tracker.png)\n\n[ok](https://example.com) [bad](javascript:alert) [local](file:///tmp/a)\n\n<img src="https://example.com/other.png">'
        }
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect([...container.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual(['https://example.com/tracker.png', 'https://example.com'])
  })

  it('copies the exact code and reports clipboard errors', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    window.desktop = { copyText: writeText } as any
    const { rerender } = render(<CodeBlock code={'x\n\n'} language="text" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('Copied'))
    expect(writeText).toHaveBeenCalledWith('x\n\n')
    writeText.mockRejectedValue(new Error('denied'))
    rerender(<CodeBlock code="y" />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('Copy failed'))
  })
})
