// Web e2e scenario: the row menu archives the Session the user is reading
// through the real composition, and the Conversation that gesture leaves goes
// to a fresh independent Agent Session instead of the locked workspace-only
// bar. Zero model calls: archive is a host RPC and the replacement Session is
// created blank, so no replay fixture mounts and a stray model stream fails
// loud.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

// The seed is another scenario's committed fixture, reused read-only: this
// spec needs any one cold Session row, not new recorded content.
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const SEED_ID = 'session-archive-current-web-e2e'

/** The interactive Agent composer; the locked no-Session bar carries the workspace placeholder instead. */
const AGENT_COMPOSER = '[data-composer-input][contenteditable="true"]'
  + '[data-placeholder="Describe what you want to build, / commands, @ files or sessions"]'
/** The locked bar's own placeholder, present only while no Session is selected. */
const LOCKED_BAR = '[data-placeholder="Choose a workspace to start"]'

describe('web e2e: archiving the current Session', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // Seed one cold session; with no Workspace registered it is the sidebar's
    // only row, in the Ungrouped bucket.
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('hands the Conversation to an independent Session instead of the workspace-only bar', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-archive-current'))
    const seededRow = page.getByRole('treeitem')
      .filter({ has: page.locator('button[aria-label^="Session actions for "]') })
    await expect.poll(() => seededRow.count(), { timeout: 10_000 }).toBe(1)
    await seededRow.click()
    await expect.poll(() => seededRow.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')

    // Archive the Session the user is reading, from its own row menu.
    const actions = seededRow.getByRole('button', { name: /^Session actions for / })
    await expect.poll(async () => {
      await seededRow.hover()
      return await actions.isVisible()
    }, { timeout: 10_000 }).toBe(true)
    await actions.click()
    await page.getByRole('menuitem', { name: 'Archive session' }).click()

    // The row leaves with the archive-set echo, and the Conversation it held
    // becomes an interactive Agent Session: the workspace-only bar and its
    // locked placeholder must not appear.
    await expect.poll(() => seededRow.count(), { timeout: 10_000 }).toBe(0)
    // What the gesture leaves is a selected blank Session row, whose
    // Conversation is its own interactive composer.
    const replacementRow = page.getByRole('treeitem').filter({ hasText: 'New Session' })
    await expect.poll(() => replacementRow.count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => replacementRow.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')
    await page.locator(AGENT_COMPOSER).waitFor({ timeout: 15_000 })
    expect(await page.locator(LOCKED_BAR).count()).toBe(0)
    expect([...scaffold.ctx.workspaceRegistry.archivedSessionIds]).toEqual([SessionId(SEED_ID)])
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)
})
