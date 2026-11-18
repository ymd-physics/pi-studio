// From pi-deepseek-tui, copyright (c) 2026 pi-open-tui contributors (MIT).
// See resources/pi-deepseek-tui-LICENSE.
// Based on native/compact-transcript/compact-transcript.js countDiff, with strict
// line/hunk validation so damaged diffs never become confirmed partial totals.
// Local copy avoids importing/installing a host patch or its mutable theme singleton.
export function countGroupDiff(diff: unknown): { added: number; removed: number } | undefined {
  if (typeof diff !== 'string') return undefined
  if (diff === '') return { added: 0, removed: 0 }
  const lines = diff.split(/\r?\n/)
  let added = 0,
    removed = 0,
    recognized = false
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
  const unified = lines.some((line) => hunkHeader.test(line))
  if (unified) {
    let oldLeft = 0,
      newLeft = 0,
      oldLine = 0,
      newLine = 0,
      file = 0
    const plus = new Set<string>(),
      minus = new Set<string>()
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const hunk = hunkHeader.exec(line)
      if (hunk) {
        if (oldLeft || newLeft) return undefined
        oldLine = Number(hunk[1])
        oldLeft = Number(hunk[2] ?? 1)
        newLine = Number(hunk[3])
        newLeft = Number(hunk[4] ?? 1)
        recognized = true
        continue
      }
      if (line.startsWith('+') && newLeft > 0) {
        plus.add(`${file}:${newLine++}`)
        newLeft--
      } else if (line.startsWith('-') && oldLeft > 0) {
        minus.add(`${file}:${oldLine++}`)
        oldLeft--
      } else if (line.startsWith(' ') && oldLeft > 0 && newLeft > 0) {
        oldLeft--
        newLeft--
        oldLine++
        newLine++
      } else if (line === '\\ No newline at end of file') continue
      else if (oldLeft || newLeft) return undefined
      else if (/^--- .+/.test(line)) {
        // File headers are a paired transition, not standalone +/- data to ignore.
        if (!/^\+\+\+ .+/.test(lines[i + 1] ?? '') || !hunkHeader.test(lines[i + 2] ?? '')) return undefined
        file++
        i++
      } else if (line === '' || /^=+$/.test(line) || [
        'diff --git ', 'diff -', 'index ', 'Index: ',
        'new file mode ', 'deleted file mode ', 'old mode ', 'new mode ',
        'similarity index ', 'dissimilarity index ', 'rename from ', 'rename to ', 'copy from ', 'copy to ',
      ].some((prefix) => line.startsWith(prefix))) continue
      else return undefined
    }
    if (oldLeft || newLeft) return undefined
    added = plus.size
    removed = minus.size
  } else {
    const plus = new Set<string>(),
      minus = new Set<string>()
    for (const line of lines) {
      const match = /^([+\- ])\s*(\d+) (.*)$/.exec(line)
      if (!match) {
        if (line === '' || /^\s*(?:…|\.\.\.)\s*$/.test(line)) continue
        return undefined
      }
      recognized = true
      if (match[1] === '+') plus.add(match[2]!)
      if (match[1] === '-') minus.add(match[2]!)
    }
    added = plus.size
    removed = minus.size
  }
  return recognized ? { added, removed } : undefined
}
