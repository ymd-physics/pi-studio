const paths = {
  closed: 'M6 3h12v18l-6-3-6 3Z',
  open: 'M3 6h18v12H3l3-6Z',
  info: 'M18 10a8 8 0 1 1-16 0 8 8 0 1 1 16 0ZM10 9.5v4m0-7v.1',
  create: 'M10 3v14M3 10h14',
  remove: 'M5.5 5.5l9 9m0-9-9 9',
}

export function WorkspaceIcon({ name, live = false }: { name: keyof typeof paths; live?: boolean }) {
  const fold = name === 'open' || name === 'closed'
  return <svg aria-hidden="true" width="16" height="16" viewBox={fold ? '0 0 24 24' : '0 0 20 20'} color={live ? 'var(--accent-text)' : undefined} fill={live ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>
}
