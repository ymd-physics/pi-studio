/** The native alert's primary message is prominent/bold; it is plain text, not HTML. */
export function namedConfirmationMessage(question: string, name: string): string {
  const line = name.replace(/\s+/g, ' ').trim()
  // Sidebar labels can fall back to an arbitrarily long first prompt. Bound the
  // alert heading without splitting Unicode code points; keep the path in detail.
  const heading = line.match(/^.{0,200}/u)![0]
  return `${question}\n\n“${heading}${heading.length < line.length ? '…' : ''}”`
}
