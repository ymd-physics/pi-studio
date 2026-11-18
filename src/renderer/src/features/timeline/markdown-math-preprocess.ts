/** Normalize complete math only; code and incomplete delimiters are never repaired. */

const ENVIRONMENT =
  '(?:equation\\*?|align\\*?|aligned|gather\\*?|gathered|multline\\*?|split|cases|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|array)'

/** Run text transforms outside fenced/indented code and matching backtick spans. */
function outsideCode(source: string, transform: (text: string) => string): string {
  const protectedParts: string[] = []
  // Choose a sentinel absent from the input, so user text cannot collide with placeholders.
  let sentinel = '\u0000'
  while (source.includes(sentinel)) sentinel += '\u0000'
  const protect = (value: string): string => `${sentinel}${protectedParts.push(value) - 1}${sentinel}`
  let fence: { char: string; length: number } | undefined
  let block = ''
  let text = ''
  for (const line of source.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const body = line.replace(/^(?: {0,3}> ?)+/, '').replace(/^ {0,3}(?:[-+*]|\d+[.)]) +/, '')
    const marker = /^\s*(`{3,}|~{3,})(.*?)(?:\r?\n)?$/.exec(body)
    if (fence) {
      block += line
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
        text += protect(block)
        block = ''
        fence = undefined
      }
    } else if (marker) {
      fence = { char: marker[1][0], length: marker[1].length }
      block = line
    } else if (/^(?: {4}|\t)/.test(body)) {
      text += protect(line)
    } else {
      text += line
    }
  }
  if (block) text += protect(block)
  // CommonMark spans close only on an equal-length run (and may cross lines).
  text = text.replace(/(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g, (match) => protect(match))
  text = transform(text)
  return text.replace(
    new RegExp(`${sentinel}(\\d+)${sentinel}`, 'g'),
    (_match, index: string) => protectedParts[Number(index)],
  )
}

function convertCompleteMath(text: string): string {
  // Existing dollar math is opaque to delimiter/environment conversion.
  return text
    .split(/(\$\$[\s\S]*?\$\$|(?<![\\$])\$(?!\$)[^\n]*?(?<!\\)\$)/g)
    .map((part, index) => {
      if (index % 2) return part
      const complete = new RegExp(
        `(?<!\\\\)(?:\\\\\\(([\\s\\S]+?)\\\\\\)|\\\\\\[([\\s\\S]+?)\\\\\\]|\\\\begin\\{(${ENVIRONMENT})\\}([\\s\\S]*?)\\\\end\\{\\3\\})`,
        'g',
      )
      return part.replace(
        complete,
        (
          match,
          inline: string | undefined,
          display: string | undefined,
          _env: string,
          _body: string,
          offset: number,
        ) => {
          if (inline !== undefined) return `$${inline.trim()}$`
          const prefix = part.slice(part.lastIndexOf('\n', offset - 1) + 1, offset)
          const indent = /^ {0,3}$/.test(prefix) ? prefix : ''
          const suffix = part.slice(offset + match.length).split('\n')[0]
          // Numeric escaped brackets in prose are commonly citations, not formulas.
          if (display !== undefined && /^\d+$/.test(display) && (prefix.trim() || suffix.trim())) return match
          return `${prefix === indent ? '' : '\n'}$$\n${indent}${display?.trim() ?? match}\n${indent}$$${suffix.trim() ? '\n' : ''}`
        },
      )
    })
    .join('')
}

export function convertLatexDelimiters(text: string): string {
  return outsideCode(text, convertCompleteMath)
}

/** Escape unmatched single dollars without guessing how an unfinished formula ends. */
export function escapeNonMathDollars(text: string): string {
  return outsideCode(text, (plain) =>
    plain
      .split(/(\$\$[\s\S]*?\$\$)/g)
      .map((part, index) => {
        if (index % 2) return part
        return part.replace(
          /(?<![\\$])\$(?!\$)([^\s$\n](?:[^$\n]*?[^\s$\n])?)(?<!\\)\$(?![\d$])|(?<![\\$])\$(?!\$)/g,
          (match, body: string | undefined) => {
            if (body === undefined) return '\\$'
            const withoutText = body.replace(/\\(?:text|mbox|mathrm|textrm|operatorname)\s*\{[^{}]*\}/g, '')
            return /[　-〿㐀-鿿豈-﫿＀-￯]/.test(withoutText) ? `\\$${body}\\$` : match
          },
        )
      })
      .join(''),
  )
}

// Kept for existing callers; streaming deliberately does not synthesize delimiters.
export function preprocessMarkdownMath(source: string, _options?: { streaming?: boolean }): string {
  return escapeNonMathDollars(convertLatexDelimiters(source))
}

/** Each rendered message must receive a fresh copy: KaTeX definitions mutate this map. */
export const KATEX_MACROS: Record<string, string> = {
  '\\RR': '\\mathbb{R}',
  '\\NN': '\\mathbb{N}',
  '\\ZZ': '\\mathbb{Z}',
  '\\QQ': '\\mathbb{Q}',
  '\\CC': '\\mathbb{C}',
  '\\dd': '\\mathrm{d}',
  '\\ee': '\\mathrm{e}',
  '\\ii': '\\mathrm{i}',
}
