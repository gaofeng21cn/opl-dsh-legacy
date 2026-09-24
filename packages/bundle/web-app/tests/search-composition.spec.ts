/** Search routing in the shipped Web and Electron patch compositions. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'

function patches(path: string): PatchOptions[] {
  return load(readFileSync(new URL(path, import.meta.url), 'utf8'), { schema: entryListSchema }) as PatchOptions[]
}

const base = patches('../../base/cordis.patch.yml')
const web = patches('../cordis.patch.yml')
const desktop = patches('../../../../apps/desktop-host/config/desktop.cordis.patch.yml')

describe('OPL search composition', () => {
  for (const [surface, layers] of [['web', [base, web]], ['desktop', [base, web, desktop]]] as const) {
    it(`${surface} selects the registered OPL provider and preserves HTTP fetch`, () => {
      const rows = applyEntryPatches([], structuredClone(layers.flat()), () => {})
      expect(rows.find(row => row.id === 'web')?.config).toEqual({
        searchProvider: 'opl-gateway', fetchProvider: 'http',
      })
      expect(rows.find(row => row.id === 'llm-opl-gateway')).toMatchObject({
        name: '@one-person-lab/dsh-llm-opl-gateway',
        config: { search: { model: 'gpt-5.6-sol', timeoutMs: 120000 } },
      })
    })
  }

  it('allows a later profile override', () => {
    const rows = applyEntryPatches([], structuredClone([...base, ...web, ...desktop, {
      id: 'web', config: { searchProvider: 'custom', fetchProvider: 'http' },
    }]), () => {})
    expect(rows.find(row => row.id === 'web')?.config).toEqual({
      searchProvider: 'custom', fetchProvider: 'http',
    })
  })
})
