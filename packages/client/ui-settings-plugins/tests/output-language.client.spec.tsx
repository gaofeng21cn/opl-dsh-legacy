// @vitest-environment jsdom

/**
 * The output-language card: the three offered languages, the write one choice
 * stages, what a fresh mount reads back from the Host document, and the
 * Chinese/English copy pair.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { OutputLanguageCard } from '../src/client/OutputLanguageCard.tsx'
import type { OutputLanguageCardProps } from '../src/client/OutputLanguageCard.tsx'
import { OutputLanguageCardController } from '../src/client/output-language-card-controller.ts'
import type { OutputLanguageCardState, OutputLanguageSettings } from '../src/client/output-language-card-controller.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

/** Form state every settled card publishes. */
const settled = {
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
}

function cardActions() {
  return { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

/** Render the card open, under one dictionary, with a card-local snapshot store. */
function renderCard(t: (key: keyof typeof en) => string, state: Partial<OutputLanguageCardState> = {}) {
  const store = createSnapshotStore<OutputLanguageCardState>({
    ...settled,
    language: { text: 'default', overridden: false, invalid: false },
    ...state,
  })
  const actions = cardActions()
  const props = {
    ...actions,
    t,
    useOutputLanguageCard: bindSnapshotSelector(store),
    view: 'page',
  } as OutputLanguageCardProps
  render(<OutputLanguageCard {...props} />)
  return { actions, store }
}

/** The rendered select's `[value, label]` pairs, in display order. */
function choices(): [string, string][] {
  const select = screen.getByLabelText(zh.outputLanguageLabel) as HTMLSelectElement
  return Array.from(select.options).map(option => [option.value, option.textContent ?? ''])
}

/** Make the stub behave like a Host that accepts every write. */
function acceptWrites(host: StubConfigForm<OutputLanguageSettings>): void {
  const section = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value as object })
  const layer = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().user as object })
  host.set.mockImplementation((field: string, value: unknown) => {
    host.publish({ value: { ...section(), [field]: value }, user: { ...layer(), [field]: value } })
  })
  host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => {
    const value = { ...section() }
    const user = { ...layer() }
    for (const op of ops) {
      const field = op.path[0]!
      if (op.op === 'set') {
        value[field] = op.value
        user[field] = op.value
      } else if (op.op === 'unset') {
        Reflect.deleteProperty(user, field)
        value[field] = (host.scope.getSnapshot().base as Record<string, unknown> | undefined)?.[field]
      }
    }
    host.publish({ value, user })
    return Promise.resolve(true)
  })
  host.unset.mockImplementation((field: string) => {
    const user = Object.fromEntries(Object.entries(layer()).filter(([key]) => key !== field))
    const base = host.scope.getSnapshot().base as Record<string, unknown> | undefined
    host.publish({ value: { ...section(), [field]: base?.[field] }, user })
  })
}

/** A card over a stub scope holding one document state, as the tab would bind it. */
function mount(
  document: { value: OutputLanguageSettings; base?: OutputLanguageSettings; user?: OutputLanguageSettings },
): { host: StubConfigForm<OutputLanguageSettings>; face: ReturnType<OutputLanguageCardController['inject']> } {
  const host = stubConfigForm<OutputLanguageSettings>()
  acceptWrites(host)
  host.publish({
    status: 'ready',
    writable: true,
    revision: 0,
    base: { outputLanguage: 'default' },
    ...document,
  })
  return { host, face: new OutputLanguageCardController(host.scope).inject() }
}

/**
 * Wait until a save has settled. A Host-accepted write republishes the resolved
 * section, which briefly makes the staged draft look clean while the save is
 * still crossing the wire, so `dirty` alone is not a settlement barrier.
 * @param state - reads the card's current snapshot.
 */
async function awaitSettled(state: () => OutputLanguageCardState): Promise<void> {
  await vi.waitFor(() => { expect(state()).toMatchObject({ saving: false, dirty: false }) })
}

describe('OutputLanguageCard', () => {
  it('offers exactly the three languages, each named in its own language', () => {
    renderCard(key => zh[key])

    expect(choices()).toEqual([
      ['default', '默认'],
      ['zh', '中文'],
      ['en', 'English'],
    ])
  })

  it('stages the chosen language through the select', () => {
    const { actions } = renderCard(key => zh[key])

    fireEvent.change(screen.getByLabelText(zh.outputLanguageLabel), { target: { value: 'zh' } })

    expect(actions.edit).toHaveBeenCalledWith('outputLanguage', 'zh')
  })

  it('stages a reset once the stored language is overridden', () => {
    const { actions } = renderCard(key => zh[key], { language: { text: 'zh', overridden: true, invalid: false } })

    fireEvent.click(screen.getByRole('button', { name: zh.reset }))

    expect(actions.resetField).toHaveBeenCalledWith('outputLanguage')
  })

  it('pairs the English UI with the same choices and self-described names', () => {
    renderCard(key => en[key])

    const select = screen.getByLabelText(en.outputLanguageLabel) as HTMLSelectElement
    expect(Array.from(select.options).map(option => [option.value, option.textContent]))
      .toEqual([
        ['default', 'Default'],
        ['zh', '中文'],
        ['en', 'English'],
      ])
  })

  it('pairs every dictionary key across Chinese and English', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect([zh.outputLanguageTitle, en.outputLanguageTitle]).toEqual(['输出语言', 'Output language'])
    expect([zh.outputLanguageLabel, en.outputLanguageLabel]).toEqual(['输出语言', 'Output language'])
    expect([zh.outputLanguageDefault, en.outputLanguageDefault]).toEqual(['默认', 'Default'])
    // A reader looking for Chinese looks for 中文 in either UI language.
    expect([zh.outputLanguageChinese, en.outputLanguageChinese]).toEqual(['中文', '中文'])
    expect([zh.outputLanguageEnglish, en.outputLanguageEnglish]).toEqual(['English', 'English'])
  })
})

describe('OutputLanguageCardController', () => {
  it('writes the staged choice into the namespace only on save', async () => {
    // An untouched document resolves the schema default, exactly as a user who
    // never opened this card sees it.
    const { host, face } = mount({ value: { outputLanguage: 'default' } })
    const state = () => face.hooks.outputLanguageCard.getSnapshot()
    expect(state().language).toEqual({ text: 'default', overridden: false, invalid: false })

    face.edit('outputLanguage', 'zh')

    expect(state()).toMatchObject({ dirty: true, language: { text: 'zh', overridden: true } })
    expect(host.set).not.toHaveBeenCalled()
    expect(host.mutate).not.toHaveBeenCalled()

    face.save()

    await awaitSettled(state)
    expect(host.scope.getSnapshot().user).toEqual({ outputLanguage: 'zh' })
    expect(state()).toMatchObject({ failed: false, language: { text: 'zh', overridden: true } })
  })

  it('reads the stored language back on a fresh mount over the same document', async () => {
    const first = mount({ value: { outputLanguage: 'default' } })
    first.face.edit('outputLanguage', 'zh')
    first.face.save()
    await awaitSettled(() => first.face.hooks.outputLanguageCard.getSnapshot())

    // A fresh browser session (or a restart) mounts over the same Host
    // document, which now resolves the stored choice.
    const second = mount({ value: { outputLanguage: 'zh' }, user: { outputLanguage: 'zh' } })

    expect(second.face.hooks.outputLanguageCard.getSnapshot())
      .toMatchObject({ available: true, dirty: false, language: { text: 'zh', overridden: true } })
  })

  it('keeps Default selectable and resettable over a stored language', async () => {
    const { host, face } = mount({ value: { outputLanguage: 'zh' }, user: { outputLanguage: 'zh' } })
    const state = () => face.hooks.outputLanguageCard.getSnapshot()

    face.edit('outputLanguage', 'default')
    expect(state()).toMatchObject({ dirty: true, language: { text: 'default', overridden: true } })
    face.save()
    await awaitSettled(state)
    expect(host.scope.getSnapshot().user).toEqual({ outputLanguage: 'default' })

    // The reset control removes the override instead: the document returns to
    // what a user who never chose a language has.
    face.resetField('outputLanguage')
    face.save()
    await awaitSettled(state)
    expect(host.scope.getSnapshot().user).toEqual({})
    expect(state()).toMatchObject({ language: { text: 'default', overridden: false } })
  })

  it('reports a language the Host did not store as a failed save', async () => {
    // The stub Host accepts the call without storing it, exactly as a schema
    // that refuses the value would.
    const host = stubConfigForm<OutputLanguageSettings>()
    host.publish({
      status: 'ready',
      writable: true,
      revision: 0,
      base: { outputLanguage: 'default' },
      value: { outputLanguage: 'default' },
    })
    const face = new OutputLanguageCardController(host.scope).inject()

    host.mutate.mockResolvedValue(false)
    face.edit('outputLanguage', 'en')
    face.save()

    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['outputLanguage'], value: 'en' }], 0)
      expect(face.hooks.outputLanguageCard.getSnapshot()).toMatchObject({ dirty: true, failed: true })
    })
  })

  it('renders nothing while the namespace is not served', () => {
    const host = stubConfigForm<OutputLanguageSettings>()
    host.publish({ status: 'unavailable', writable: false })

    expect(new OutputLanguageCardController(host.scope).inject()
      .hooks.outputLanguageCard.getSnapshot().available).toBe(false)
  })
})
