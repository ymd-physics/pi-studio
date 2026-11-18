import { describe, expect, it } from 'vitest'
import { JsonLines } from './rpc'

describe('Pi RPC framing', () => {
  it('preserves multibyte characters and Unicode separators across every byte boundary', () => {
    const expected = [
      { type: 'event', text: '数学 😀\u2028\u2029' },
      { type: 'response', success: true, id: '2' },
    ]
    const bytes = Buffer.from(expected.map((record) => JSON.stringify(record)).join('\r\n') + '\n')
    const actual: unknown[] = []
    const reader = new JsonLines((record) => actual.push(record))
    for (const byte of bytes) reader.push(Buffer.from([byte]))
    expect(actual).toEqual(expected)
  })
  it('does not parse until LF and rejects malformed complete records', () => {
    const actual: unknown[] = []
    const reader = new JsonLines((record) => actual.push(record))
    reader.push(Buffer.from('{"type":"event"}'))
    expect(actual).toHaveLength(0)
    reader.push(Buffer.from('\n\n'))
    expect(actual).toHaveLength(1)
    expect(() => reader.push(Buffer.from('not JSON\n'))).toThrow()
  })
})
