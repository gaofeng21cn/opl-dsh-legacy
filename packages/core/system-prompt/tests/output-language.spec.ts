/**
 * The output-language setting: the user-selected language for model-authored
 * prose, its persistence in the settings document, and the prompt section it
 * renders. The rendered prompt is the model-visible contract, so the directive
 * text is pinned verbatim here.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import SystemPrompt, {
  OUTPUT_LANGUAGE_SECTION,
  OUTPUT_LANGUAGE_SETTINGS_NAMESPACE,
  renderPrompt,
} from '@deepseek-ai/dsh-system-prompt'

const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
const NS = OUTPUT_LANGUAGE_SETTINGS_NAMESPACE
const ZH_DIRECTIVE = 'Write your final replies, and every document, report, or documentation file you produce, '
  + 'in Simplified Chinese (简体中文). Keep code, identifiers, commands, file paths, and quoted source text '
  + 'in their original form. If the user explicitly requests a different language for a specific item, follow that request.'
const EN_DIRECTIVE = 'Write your final replies, and every document, report, or documentation file you produce, '
  + 'in English. Keep code, identifiers, commands, file paths, and quoted source text in their original form. '
  + 'If the user explicitly requests a different language for a specific item, follow that request.'

/** Every temp settings document created by this file, removed after each test. */
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Write one temp settings document and return its path. */
async function settingsDocument(content: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-output-language-'))
  roots.push(home)
  const file = join(home, 'settings.yaml')
  await writeFile(file, content)
  return file
}

/** Mount the real file-backed settings provider, then the prompt registry over it. */
async function harness(file: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(FileSettingsProvider, { path: file, watch: false })
  await ctx.plugin(SystemPrompt, { includeRuntimeContext: false })
  return ctx
}

describe('output language', () => {
  it('renders no directive without a settings provider (current behavior)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are the deployment.' })

    const assembly = await ctx.systemPrompt.assemble()
    expect(renderPrompt(assembly)).toBe(`${IDENTITY}\n\nYou are the deployment.`)
    expect(assembly.sections.find(section => section.name === OUTPUT_LANGUAGE_SECTION)?.text).toBe('')
  })

  it('resolves an absent section and an explicit default to no directive', async () => {
    for (const content of ['{}\n', 'output-language:\n  language: default\n']) {
      const ctx = await harness(await settingsDocument(content))
      expect(ctx.settings.get(NS)).toEqual({ language: 'default' })
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(IDENTITY)
    }
  })

  it('keeps an existing document that predates the section compatible', async () => {
    const file = await settingsDocument('llm-deepseek:\n  apiKeyEnv: DEEPSEEK_API_KEY\n')
    const ctx = await harness(file)

    expect(ctx.settings.get(NS)).toEqual({ language: 'default' })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(IDENTITY)
  })

  it('renders the Chinese directive for zh, after the deployment persona', async () => {
    const file = await settingsDocument('output-language:\n  language: zh\n')
    const ctx = new Context()
    await ctx.plugin(FileSettingsProvider, { path: file, watch: false })
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are the deployment.', includeRuntimeContext: false })

    expect(renderPrompt(await ctx.systemPrompt.assemble()))
      .toBe(`${IDENTITY}\n\nYou are the deployment.\n\n${ZH_DIRECTIVE}`)
  })

  it('renders the English directive for en', async () => {
    const ctx = await harness(await settingsDocument('output-language:\n  language: en\n'))

    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`${IDENTITY}\n\n${EN_DIRECTIVE}`)
  })

  it('applies a committed change on the next assembly and clears on reset', async () => {
    const ctx = await harness(await settingsDocument('output-language:\n  language: zh\n'))
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`${IDENTITY}\n\n${ZH_DIRECTIVE}`)

    await ctx.settings.update(NS, { language: 'en' })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`${IDENTITY}\n\n${EN_DIRECTIVE}`)

    await ctx.settings.replace(NS, {})
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(IDENTITY)
  })

  it('starts applying when a settings provider attaches after the registry', async () => {
    const file = await settingsDocument('output-language:\n  language: en\n')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { includeRuntimeContext: false })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(IDENTITY)

    await ctx.plugin(FileSettingsProvider, { path: file, watch: false })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`${IDENTITY}\n\n${EN_DIRECTIVE}`)
  })

  it('persists the selection in the document and restores it on a fresh host', async () => {
    const file = await settingsDocument('{}\n')
    const first = await harness(file)
    await first.settings.update(NS, { language: 'zh' })
    await first.fiber.dispose()

    expect(await readFile(file, 'utf8')).toContain('output-language')
    const second = await harness(file)
    expect(second.settings.get(NS)).toEqual({ language: 'zh' })
    expect(renderPrompt(await second.systemPrompt.assemble())).toBe(`${IDENTITY}\n\n${ZH_DIRECTIVE}`)
  })

  it('is one global preference: every scope reads it, and a scoped section shadows it', async () => {
    // The settings seam holds one Host-wide user document; it has no per-workspace
    // layer, so the same section governs every workspace and agent scope.
    const ctx = await harness(await settingsDocument('output-language:\n  language: zh\n'))
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, { name: 'child' }) },
      { inject: ['systemPrompt'] }))
    const key = scopeOf(scope.ctx)!

    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).toBe(`${IDENTITY}\n\n${ZH_DIRECTIVE}`)

    scope.ctx.systemPrompt.section({
      name: OUTPUT_LANGUAGE_SECTION,
      order: ctx.systemPrompt.getSectionOrder('OUTPUT_LANGUAGE'),
      text: 'Per-agent prompt.',
    })
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).toBe(`${IDENTITY}\n\nPer-agent prompt.`)
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`${IDENTITY}\n\n${ZH_DIRECTIVE}`)
  })
})
