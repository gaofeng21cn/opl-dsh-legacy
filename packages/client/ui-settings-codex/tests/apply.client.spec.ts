// @vitest-environment jsdom
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { afterEach, expect, vi } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { CodexSkillBridge } from '../src/types.ts'

const SELF = '@one-person-lab/dsh-client-ui-settings-codex'
const it = createClientTest({ roster: webApp.closure([SELF, '@deepseek-ai/dsh-client-ui-settings-general']) })
afterEach(() => vi.unstubAllGlobals())

it('registers through the real Loader and keeps installation out of activation', async ({ start }) => {
  const codex: CodexSkillBridge = {
    status: vi.fn(async () => ({ state: 'missing' as const, directory: '/codex/skills/opl-dsh-workflow', autoStart: true })),
    install: vi.fn(),
  }
  vi.stubGlobal('dshDesktop', { protocolVersion: 1, codex })
  const client = await start()
  const entry = client.ctx.slots.entries('settings.section').find(row => row.options.id === 'codex')!
  expect(entry).toBeDefined()
  expect(resolveSlotLabel(entry.options.label)).toMatch(/Codex/)
  expect(codex.install).not.toHaveBeenCalled()
  await client.unload(SELF)
  expect(client.ctx.slots.entries('settings.section').some(row => row.options.id === 'codex')).toBe(false)
}, 60_000)

it('has no settings entry in an ordinary browser', async ({ start }) => {
  vi.stubGlobal('dshDesktop', undefined)
  const client = await start()
  expect(client.ctx.slots.entries('settings.section').some(row => row.options.id === 'codex')).toBe(false)
}, 60_000)
