import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { resolveCompactSpec, resolveTargetPolicy } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'

/** Repository root, four levels above this test file. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
/** Shipped preset every standard-composition session mounts. */
const STANDARD_PRESET = join(repoRoot, 'packages/bundle/web-app/presets/standard.patch.yml')
/** OPL development-agent profile patch over the shipped headless profile. */
const OPL_HEADLESS_PATCH = join(repoRoot, 'apps/cli/config/opl-headless.cordis.patch.yml')

/**
 * Extract one `id`-named row's exact YAML lines from a shipped composition,
 * dedented to column zero so the Loader mounts the text that ships instead of a
 * hand-copied duplicate. Stops at the next sibling row or shallower line.
 * @param path - composition file to read.
 * @param id - row id to extract.
 * @returns the row's lines, including its own list marker.
 */
async function compositionRow(path: string, id: string): Promise<string[]> {
  const lines = (await readFile(path, 'utf8')).split('\n')
  const start = lines.findIndex(line => new RegExp(`^\\s*-\\s+id:\\s*${id}\\s*$`, 'u').test(line))
  if (start === -1) throw new Error(`${path}: no composition row with id ${id}`)
  const indent = /^\s*/u.exec(lines[start] as string)?.[0].length ?? 0
  const row: string[] = []
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] as string
    const leading = /^\s*/u.exec(line)?.[0].length ?? 0
    const sibling = leading === indent && line.trimStart().startsWith('- ')
    if (index > start && line.trim() !== '' && (leading < indent || sibling)) break
    row.push(line.slice(indent))
  }
  return row
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-token-meter-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-compaction-tool-result-pruner', ToolResultPruner],
    ['@deepseek-ai/dsh-compaction-basic', BasicCompactionEngine],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it('loads the shipped token-meter, pruning, and compaction-basic YAML order', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
      '  config:',
      '    thresholdChars: 100',
      '    headChars: 20',
      '    tailChars: 10',
      "- name: '@deepseek-ai/dsh-compaction-basic'",
      '  config:',
      '    thresholdRatio: 0.5',
      '    headroomTokens: 4000',
      '    modelPolicies:',
      '      - provider: mock',
      '        model: small',
      '        headroomTokens: 0',
      '        maxTokens: 32',
      '    retainRatio: 0.125',
      '    auto: false',
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.get('toolResultPruner')).toBeInstanceOf(ToolResultPruner)
    expect(loaded.get('compaction')).toBeInstanceOf(BasicCompactionEngine)
    expect((loaded.compaction as BasicCompactionEngine).config).toMatchObject({
      thresholdRatio: 0.5,
      headroomTokens: 4000,
      modelPolicies: [{ provider: 'mock', model: 'small', headroomTokens: 0, maxTokens: 32 }],
      retainRatio: 0.125,
      auto: false,
    })
  })

  it('scopes the shipped standard preset budget to the OPL route through the real Loader', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      ...await compositionRow(STANDARD_PRESET, 'compaction-basic'),
    ])

    const engine = loaded.compaction as unknown as BasicCompactionEngine
    expect(engine.config).toMatchObject({ thresholdRatio: 0.8, retainRatio: 0.16, auto: true })
    expect(engine.config.inputBudget).toBeUndefined()
    expect(engine.config.modelPolicies).toEqual([{
      provider: 'opl-gateway',
      model: 'deepseek-flash',
      inputBudget: 258_400,
      thresholdTokens: 244_800,
    }])

    // The OPL route keeps its nominal 1M capability; only its own policy moves.
    const opl = resolveTargetPolicy(engine.config, { provider: 'opl-gateway', model: 'deepseek-flash' })
    expect(resolveCompactSpec(opl, 1_000_000)).toMatchObject({
      contextWindow: 1_000_000,
      inputBudget: 258_400,
      thresholdTokens: 244_800,
      retainTokens: 41_344,
    })
    // The upstream headroom rule still rejects a window smaller than its default margin.
    expect(() => resolveCompactSpec(opl, 64_000)).toThrow(/headroom tokens/)

    // Every other provider sharing this preset keeps the plugin defaults scaled
    // from its own capacity, including the same model id on another provider.
    for (const target of [
      { provider: 'deepseek-official', model: 'deepseek-flash' },
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      { provider: 'local', model: 'small-context' },
    ]) {
      expect(resolveCompactSpec(resolveTargetPolicy(engine.config, target), 1_000_000)).toMatchObject({
        inputBudget: 1_000_000,
        thresholdTokens: 800_000,
        retainTokens: 160_000,
      })
    }
  })

  it('resolves the shipped OPL headless profile patch as the same route budget', async () => {
    const patch = await compositionRow(OPL_HEADLESS_PATCH, 'compaction-basic')
    // The patch row carries no `name`: it configures the base bundle's own
    // compaction-basic row, which is the composition this profile boots.
    expect(patch[0]).toBe('- id: compaction-basic')
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      '- id: compaction-basic',
      "  name: '@deepseek-ai/dsh-compaction-basic'",
      ...patch.slice(1),
    ])

    const engine = loaded.compaction as unknown as BasicCompactionEngine
    expect(engine.config).toMatchObject({
      inputBudget: 258_400,
      thresholdTokens: 244_800,
      auto: true,
    })
    expect(resolveCompactSpec(
      resolveTargetPolicy(engine.config, { provider: 'opl-gateway', model: 'deepseek-flash' }),
      1_000_000,
    )).toMatchObject({
      inputBudget: 258_400,
      thresholdTokens: 244_800,
      retainTokens: 41_344,
    })
  })

  it('rejects stale token-meter config after Schemastery normalization', async () => {
    context = new Context()
    await context.plugin(SessionProjectionRegistry)
    await expect(context.plugin(TokenMeter, {
      contextWindow: 4096,
    } as never)).rejects.toThrow(/TokenMeterConfig: unknown key "contextWindow"/)
  })

  it('rejects stale compaction-basic config after Schemastery normalization', async () => {
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(TokenMeter)
    await expect(context.plugin(BasicCompactionEngine, {
      models: { legacy: { thresholdRatio: 0.5 } },
    } as never)).rejects.toThrow(/BasicCompactionConfig: unknown key "models"/)
  })

  it('rejects a capacity-independent merged ratio conflict during plugin load', async () => {
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(TokenMeter)
    await expect(context.plugin(BasicCompactionEngine, {
      retainRatio: 0.2,
      modelPolicies: [{
        provider: 'test-provider',
        model: 'test-model',
        thresholdRatio: 0.1,
      }],
    })).rejects.toThrow(/modelPolicies\[0\]: retainRatio \(0.2\).*thresholdRatio \(0.1\)/)
  })

  it('rejects an incomplete model-policy summarization pair during plugin load', async () => {
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(TokenMeter)
    await expect(context.plugin(BasicCompactionEngine, {
      summarizationProvider: 'default-provider',
      summarizationModel: 'default-model',
      modelPolicies: [{
        provider: 'test-provider',
        model: 'test-model',
        summarizationModel: '',
      }],
    })).rejects.toThrow(/modelPolicies\[0\].*must be set together/)
  })
})
