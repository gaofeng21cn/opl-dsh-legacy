// @vitest-environment jsdom
import type {} from '../src/client/index.ts'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexSection } from '../src/client/CodexSection.tsx'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { en, type CodexLocaleKey } from '../src/client/locales.ts'
import type { CodexSkillStatus } from '../src/types.ts'

function unused(): never { throw new Error('Unexpected global hook') }
const globals: GlobalStandardProps = {
  usePanelInfo: unused, useSessions: unused, useSessionStatus: unused,
  useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
}

afterEach(cleanup)
const missing: CodexSkillStatus = { state: 'missing', directory: '/local/codex/skills/opl-dsh-workflow', autoStart: true }

it('checks status without installation and saves only on an explicit click', async () => {
  const status = vi.fn(async () => missing)
  const install = vi.fn(async ({ autoStart }: { autoStart: boolean }): Promise<CodexSkillStatus> => ({ ...missing, state: 'current', autoStart }))
  render(<CodexSection {...globals} t={key => key in en ? en[key as CodexLocaleKey] : key}
    status={status} install={install} close={() => {}} />)
  await screen.findByText(en.missing)
  expect(install).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: en.install }))
  await screen.findByText(en.saved)
  expect(install).toHaveBeenCalledExactlyOnceWith({ autoStart: false })
  expect(screen.getByText(missing.directory)).toBeTruthy()
})

it('explains conflicts and keeps the installation action disabled', async () => {
  const status = async (): Promise<CodexSkillStatus> => ({ ...missing, state: 'modified' })
  const install = vi.fn()
  render(<CodexSection {...globals} t={key => key in en ? en[key as CodexLocaleKey] : key}
    status={status} install={install} close={() => {}} />)
  await screen.findByText(en.modified)
  expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  expect(install).not.toHaveBeenCalled()
})
