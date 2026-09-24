/** Keyless real-composition coverage for independent sessions and project moves. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, writeComposerDraft } from './support.ts'

class ChatAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PLAIN_CHAT_REPLY_OK' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
let scaffold: WebScaffold
let browser: Browser
let page: Page
const adapter = new ChatAdapter()
beforeAll(async () => {
  scaffold = await launchWebScaffold()
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['plain-chat-test'], adapter))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'plain-chat-test', model: 'reply' })
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl)
})
afterAll(async () => { await browser?.close(); await scaffold?.close() })
it('runs independent tasks and moves project membership without changing relative paths', async () => {
  await page.getByRole('button', { name: 'New session', exact: true }).last().waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: 'New session', exact: true }).last().click()
  const editor = page.locator('[contenteditable="true"]').first()
  await editor.waitFor()
  await writeComposerDraft(page, editor, 'Hello, this is an independent task.')
  await editor.press('Enter')
  await page.getByText('PLAIN_CHAT_REPLY_OK', { exact: true }).waitFor({ timeout: 30000 })
  const agent = scaffold.ctx.agents.list().at(-1)!
  expect(agent).toBeDefined()
  expect(scaffold.ctx.agentPresets.composedPreset(agent.ctx)).not.toBe('chat')
  expect(scaffold.ctx.tools.schemas(agent).length).toBeGreaterThan(0)
  expect(await page.getByRole('treeitem').filter({ hasText: 'Chats' }).count()).toBe(0)
  scaffold.ctx.sessionTitle.rename(agent.session, 'Independent task')
  const id = agent.session.id
  const cwd = agent.session.header.cwd!
  await writeFile(join(cwd, 'relative-path.txt'), 'retained')
  const targetPath = join(cwd, 'target-project')
  await mkdir(targetPath)
  const target = await scaffold.ctx.workspaceRegistry.create(targetPath)
  await page.getByRole('treeitem').filter({ hasText: 'Independent task' }).last().hover()
  await page.getByRole('button', { name: 'Session actions for Independent task', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Move to project…', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: target.title, exact: true }).click()
  await expect.poll(() => target.sessionIds.includes(id)).toBe(true)
  expect(target.sessionIds).toContain(id)
  expect(agent.session.header.cwd).toBe(cwd)
  expect(await readFile(join(cwd, 'relative-path.txt'), 'utf8')).toBe('retained')
  await page.reload()
  const row = page.getByRole('treeitem').filter({ hasText: 'Independent task' }).last()
  // Reload may select a fresh blank task; existing history remains available in the project.
  const projectRow = page.getByRole('treeitem').filter({ has: page.getByText('target-project', { exact: true }) }).first()
  await projectRow.waitFor()
  if (await projectRow.getAttribute('aria-expanded') === 'false') await page.getByText('target-project', { exact: true }).first().click()
  await row.click()
  await page.getByText('PLAIN_CHAT_REPLY_OK', { exact: true }).waitFor({ timeout: 30000 })
  await row.hover()
  await row.getByRole('button', { name: /^Session actions for/ }).click()
  await page.getByRole('menuitem', { name: 'Move to project…', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Move outside projects' }).click()
  await expect.poll(() => target.sessionIds.includes(id)).toBe(false)
  expect(scaffold.ctx.workspaceRegistry.list().flatMap(project => project.sessionIds)).not.toContain(id)
  await page.getByText('target-project', { exact: true }).first().hover()
  await page.getByRole('button', { name: 'New session in target-project', exact: true }).click()
  await expect.poll(() => scaffold.ctx.agents.list().some(candidate => candidate.session.header.cwd === target.path)).toBe(true)
  const projectAgent = scaffold.ctx.agents.list().find(candidate => candidate.session.header.cwd === target.path)!
  expect(target.sessionIds).toContain(projectAgent.session.id)
  await page.getByRole('button', { name: 'New session', exact: true }).last().click()
  await expect.poll(() => scaffold.ctx.agents.list().at(-1)?.session.header.cwd).not.toBe(target.path)
  const directories = scaffold.ctx.agents.list().map(candidate => candidate.session.header.cwd)
  expect(new Set(directories).size).toBeGreaterThan(1)
  expect({
    hasTools: scaffold.ctx.tools.schemas(agent).length > 0,
    isProjectless: !scaffold.ctx.workspaceRegistry.list().some(project => project.sessionIds.includes(id)),
    retainedRelativeFile: await readFile(join(cwd, 'relative-path.txt'), 'utf8'),
    retainedCwd: agent.session.header.cwd === cwd,
  }).toMatchInlineSnapshot(`
    {
      "hasTools": true,
      "isProjectless": true,
      "retainedCwd": true,
      "retainedRelativeFile": "retained",
    }
  `)
  if (process.env.DSH_ACCEPTANCE_SCREENSHOT) await page.screenshot({ path: process.env.DSH_ACCEPTANCE_SCREENSHOT, fullPage: true })
})
