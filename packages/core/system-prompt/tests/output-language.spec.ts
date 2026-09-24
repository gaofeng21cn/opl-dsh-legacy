/** Live output language in ordinary SystemPrompt Loader configuration. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { OUTPUT_LANGUAGE_SECTION, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
const ZH_DIRECTIVE = 'Write your final replies, and every document, report, or documentation file you produce, '
  + 'in Simplified Chinese (简体中文). Keep code, identifiers, commands, file paths, and quoted source text '
  + 'in their original form. If the user explicitly requests a different language for a specific item, follow that request.'
const EN_DIRECTIVE = 'Write your final replies, and every document, report, or documentation file you produce, '
  + 'in English. Keep code, identifiers, commands, file paths, and quoted source text in their original form. '
  + 'If the user explicitly requests a different language for a specific item, follow that request.'
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function harness(config: object = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const live = await liveConfig(ctx, SystemPrompt, { includeRuntimeContext: false, ...config })
  return { ctx, live }
}

describe('output language', () => {
  it('adds no directive for omitted or default output language', async () => {
    for (const config of [{}, { outputLanguage: 'default' }]) {
      const { ctx } = await harness(config)
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(IDENTITY)
    }
  })

  it.each([['zh', ZH_DIRECTIVE], ['en', EN_DIRECTIVE]])('renders the %s directive after the deployment persona', async (outputLanguage, directive) => {
    const { ctx } = await harness({ outputLanguage, personaPrefix: 'You are the deployment.' })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`${IDENTITY}\n\nYou are the deployment.\n\n${directive}`)
  })

  it('applies a live configuration edit to the next assembly without replacing the service', async () => {
    const { ctx, live } = await harness({ outputLanguage: 'zh' })
    const prompt = ctx.systemPrompt
    expect(renderPrompt(await prompt.assemble())).toBe(`${IDENTITY}\n\n${ZH_DIRECTIVE}`)
    await live.update({ outputLanguage: 'en' })
    expect(live.entry.fiber === live.fiber).toBe(true)
    expect(renderPrompt(await prompt.assemble())).toBe(`${IDENTITY}\n\n${EN_DIRECTIVE}`)
    await live.replace({})
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(IDENTITY)
  })

  it('rejects unsupported output languages at the configuration boundary', async () => {
    const { live } = await harness()
    await expect(live.update({ outputLanguage: 'invalid' })).rejects.toThrow()
  })

  it('allows an agent-scoped section to shadow the deployment preference', async () => {
    const { ctx } = await harness({ outputLanguage: 'zh' })
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, { name: 'child' }) }, { inject: ['systemPrompt'] }))
    const key = scopeOf(scope.ctx)!
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).toBe(`${IDENTITY}\n\n${ZH_DIRECTIVE}`)
    scope.ctx.systemPrompt.section({ name: OUTPUT_LANGUAGE_SECTION, order: ctx.systemPrompt.getSectionOrder('OUTPUT_LANGUAGE'), text: 'Per-agent prompt.' })
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).toBe(`${IDENTITY}\n\nPer-agent prompt.`)
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`${IDENTITY}\n\n${ZH_DIRECTIVE}`)
  })
})
