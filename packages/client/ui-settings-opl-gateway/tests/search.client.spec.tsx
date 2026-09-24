// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SearchSection } from '../src/client/SearchSection.tsx'
import { en, type OplGatewayLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)
const t = (key: OplGatewayLocaleKey) => en[key]

it('tests unsaved local selection, refreshes failed accounting, and only saves explicitly', async () => {
  const status = { preferences: { mode: 'cloud', model: 'gpt-5.6-sol' }, totals: { calls: 0, succeeded: 0, failed: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, unknownUsage: 0 }, buckets: [] }
  const searchStatus = vi.fn(async () => status)
  const searchConfigure = vi.fn(async () => status)
  const searchTest = vi.fn(async () => { throw new Error('Network unavailable') })
  const props = {
    t,
    searchStatus,
    searchConfigure,
    searchTest,
    searchModels: async () => [],
  } as unknown as ComponentProps<typeof SearchSection>
  render(<SearchSection {...props} />)
  const mode = screen.getByLabelText(en['search.mode'])
  await waitFor(() => expect((mode as HTMLSelectElement).disabled).toBe(false))
  fireEvent.change(mode, { target: { value: 'local' } })
  fireEvent.click(screen.getByRole('button', { name: en['search.test'] }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Network unavailable')
  expect(searchTest).toHaveBeenCalledWith({ mode: 'local', model: 'gpt-5.6-sol' }, 'DeepSeek Harness GitHub')
  expect(searchStatus).toHaveBeenCalledTimes(2)
  expect(searchConfigure).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en['search.save'] }))
  await waitFor(() => expect(searchConfigure).toHaveBeenCalledWith({ mode: 'local', model: 'gpt-5.6-sol' }))
})
