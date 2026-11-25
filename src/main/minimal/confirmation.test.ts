import { expect, it } from 'vitest'
import { namedConfirmationMessage } from './confirmation'

it('places the target on its own quoted line in the native primary message', () => {
  expect(namedConfirmationMessage('Move this Pi session to Trash?', '量子 · QFT')).toBe('Move this Pi session to Trash?\n\n“量子 · QFT”')
  expect(namedConfirmationMessage('关闭这个终端吗？', '  Experiment\n\tA  ')).toBe('关闭这个终端吗？\n\n“Experiment A”')
})

it('bounds long prompt-derived labels without splitting Unicode code points', () => {
  expect(namedConfirmationMessage('Delete?', '🧪'.repeat(201))).toBe(`Delete?\n\n“${'🧪'.repeat(200)}…”`)
  expect(namedConfirmationMessage('Delete?', 'x'.repeat(200))).toBe(`Delete?\n\n“${'x'.repeat(200)}”`)
})
