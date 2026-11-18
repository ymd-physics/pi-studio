// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CompactionNotice } from './CompactionNotice'

afterEach(cleanup)

it('identifies the current Codex model while a silent external compressor is running, not an unconfirmed engine', () => {
  const value = { status: 'running' as const, notices: [] }
  const { rerender } = render(<CompactionNotice value={value} modelProvider="openai-codex" />)
  expect(screen.getByText('Compacting…')).toBeTruthy()
  expect(screen.getByText('Model: OpenAI Codex').title).toContain('has not reported')
  expect(screen.queryByText('OpenAI Codex · Compacting…')).toBeNull()
  rerender(<CompactionNotice value={{ ...value, engine: 'openai-codex' }} modelProvider="openai-codex" />)
  expect(screen.getByText('OpenAI Codex · Compacting…')).toBeTruthy()
  expect(screen.queryByText('Model: OpenAI Codex')).toBeNull()
})

it('does not infer Codex from a generic OpenAI model or carry a model hint into a non-Codex result', () => {
  const { rerender } = render(
    <CompactionNotice value={{ status: 'running', notices: [] }} modelProvider="openai" />,
  )
  expect(screen.queryByText('Model: OpenAI Codex')).toBeNull()
  rerender(
    <CompactionNotice
      value={{ status: 'complete', notices: [], result: { summary: 'Native summary' } }}
      modelProvider="openai-codex"
    />,
  )
  expect(screen.getByText('Context compacted')).toBeTruthy()
  expect(screen.queryByText('Model: OpenAI Codex')).toBeNull()
  expect(screen.queryByText(/Encrypted checkpoint saved/)).toBeNull()
})
