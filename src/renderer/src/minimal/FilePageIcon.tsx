// One folded sheet; only its interior mark changes between formats.
const formats: [RegExp, string][] = [
  [/\.(md|mdx|markdown)$/i, 'M8 16v-5l2.5 3 2.5-3v5'],
  [/\.(tex|sty|cls|bib)$/i, 'M8 12h7m-3.5 0v5'],
  [/\.(pdf|txt|rtf|docx?)$/i, 'M8 12h7m-7 3h5'],
  [/\.(py|js|mjs|cjs|jsx|ts|tsx|html|css|c|cpp|h|rs|go|java|jl)$/i, 'm9 12-2 2 2 2m5-4 2 2-2 2'],
  [/\.(sh|bash|zsh|fish|ps1)$/i, 'm8 12 2 2-2 2m4 0h3'],
  [/\.(json|jsonl|yaml|yml|toml|ini)$/i, 'M10 11H9v2l-1 1 1 1v2h1m3-6h1v2l1 1-1 1v2h-1'],
  [/\.(png|jpe?g|gif|svg|webp|heic|tiff?|bmp|avif)$/i, 'm7 16 3-4 2 2 2-3 2 5'],
  [/\.(csv|tsv|xlsx?|ods)$/i, 'M8 11h8v6H8z M8 14h8m-5-3v6'],
  [/\.(zip|gz|tar|bz2|xz|7z|rar)$/i, 'M10 10v2h2v2h-2v2h2'],
]
export function FilePageIcon({ name }: { name: string }) {
  const mark = formats.find(([pattern]) => pattern.test(name))?.[1]
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{flexShrink:0}}>
    <path d="M5 3h9l5 5v13H5z M14 3v5h5" />{mark && <path d={mark} />}
  </svg>
}
