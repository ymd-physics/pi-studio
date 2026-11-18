import { useUiText } from './language'
import { Children, isValidElement, memo, useContext, useEffect, useState } from 'react'
import { MarkdownLink, MarkdownImage, MarkdownOrigin, type MarkdownLocation } from './MarkdownLinks'
import { linkKind } from '../../../../packages/shared/links'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { highlightCodeToHtml } from '../lib/shiki-highlighter'
import { KATEX_MACROS, preprocessMarkdownMath } from '../features/timeline/markdown-math-preprocess'

export const CodeBlock = memo(function CodeBlock({ code, language }: { code: string; language?: string }) {
  const t = useUiText()
  const [highlighted, setHighlighted] = useState<{ code: string; language?: string; html: string }>()
  const [copyStatus, setCopyStatus] = useState('Copy')
  useEffect(() => {
    let active = true
    setCopyStatus('Copy')
    // The upstream highlighter removes one final newline; compensate to preserve the code.
    void highlightCodeToHtml(`${code}\n`, language)
      .then((html) => {
        if (active) setHighlighted({ code, language, html })
      })
      .catch(() => {
        /* Plain React text remains the safe fallback. */
      })
    return () => {
      active = false
    }
  }, [code, language])
  const html = highlighted?.code === code && highlighted.language === language ? highlighted.html : undefined
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language ?? t('text')}</span>
        <button
          type="button"
          onClick={async () => {
            try {
              await window.desktop.copyText(code)
              setCopyStatus('Copied')
            } catch {
              setCopyStatus('Copy failed')
            }
          }}
        >
          {t(copyStatus)}
        </button>
      </div>
      {html ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
})

function DisplayEquation({ source, children }: { source: string; children: React.ReactNode }) {
  const t = useUiText()
  const [status, setStatus] = useState('Copy LaTeX')
  useEffect(() => setStatus('Copy LaTeX'), [source])
  return (
    <div className="display-equation">
      <div className="equation-scroll">{children}</div>
      <button
        className="equation-copy"
        type="button"
        aria-label={t(status)}
        title={t(status)}
        onClick={async () => {
          try {
            await window.desktop.copyText(source)
            setStatus('LaTeX copied')
          } catch {
            setStatus('Copy failed')
          }
        }}
      >
        {t(status)}
      </button>
    </div>
  )
}

type CodeNode = {
  type: string
  value?: string
  lang?: string
  data?: { hName?: string; hChildren?: unknown[]; hProperties?: Record<string, unknown> }
  children?: CodeNode[]
}

/** A fenced `math` sample is still code, not an instruction to execute KaTeX. */
function preserveMathCode() {
  return (tree: CodeNode) => {
    const visit = (node: CodeNode) => {
      if (node.type === 'code' && node.lang === 'math') {
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, className: ['language-code-math'] },
        }
      }
      // Preserve the parsed TeX before KaTeX expands macros or replaces the math node.
      // The inner pre/code pair remains available to rehype-katex (including errors).
      if (node.type === 'math') {
        node.data = {
          hName: 'div',
          hProperties: { 'data-latex-source': node.value || '' },
          hChildren: [
            { type: 'element', tagName: 'pre', properties: {}, children: node.data?.hChildren || [] },
          ],
        }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

// Stable component TYPES are essential: inline functions remount every code/equation
// on each streaming delta, rerunning highlighting and losing copy/selection state.
const markdownComponents: Components = {
  div({ node, children }) {
    const source = node?.properties['data-latex-source']
    return typeof source === 'string' ? (
      <DisplayEquation source={source}>{children}</DisplayEquation>
    ) : (
      <div>{children}</div>
    )
  },
  table: function Table({ children }) {
    const t = useUiText()
    return (
      <div className="table-scroll" tabIndex={0} role="region" aria-label={t('Table')}>
        <table>{children}</table>
      </div>
    )
  },
  pre({ children }) {
    const child = Children.toArray(children)[0]
    if (!isValidElement<{ className?: string; children?: unknown }>(child)) return <pre>{children}</pre>
    const language = /language-(\S+)/.exec(child.props.className ?? '')?.[1]
    return (
      <CodeBlock
        code={String(child.props.children ?? '')}
        language={language === 'code-math' ? 'math' : language}
      />
    )
  },
  a: function Link({ href, children, node }) {
    const t = useUiText()
    // Linked images already have an original-file action; never nest anchors.
    if (node?.children.some(child => child.type === 'element' && child.tagName === 'img'))
      return <span className="linked-markdown-image">{children}<MarkdownLink href={href}>{t('Open linked file')}</MarkdownLink></span>
    return <MarkdownLink href={href}>{children}</MarkdownLink>
  },
  img({ src, alt }) {
    return <MarkdownImage src={src} alt={alt} />
  },
}
export function Markdown({ text, origin }: { text: string; origin?: MarkdownLocation }) {
  const inherited = useContext(MarkdownOrigin)
  return (
    <MarkdownOrigin.Provider value={origin || inherited}><div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, preserveMathCode]}
        rehypePlugins={[
          [
            rehypeKatex,
            { macros: { ...KATEX_MACROS }, trust: false, maxExpand: 1000, maxSize: 20, strict: 'warn' },
          ],
        ]}
        skipHtml
        urlTransform={url => linkKind(url) ? url : ''}
        components={markdownComponents}
      >
        {preprocessMarkdownMath(text)}
      </ReactMarkdown>
    </div></MarkdownOrigin.Provider>
  )
}
