// Archive and restore through sidebar row menus and the archived filter,
// then reload from the Host baseline. This flow makes no model calls.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, seedSession, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

// The seed is another scenario's committed fixture, reused read-only: this
// spec needs any one cold Session row, not new recorded content.
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const SEED_ID = 'session-unarchive-web-e2e'

describe('web e2e: archived sessions are restored from the sidebar filter', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  /**
   * The ordinary Session rows. Sessions outside every project are direct rows
   * under the section header, so there is no bucket to expand; a blank
   * New Session row is a provisional placeholder without the row verbs and is
   * therefore not one of these.
   * @returns the locator matching ordinary Session rows.
   */
  function ordinaryRows(): Locator {
    return page.getByRole('treeitem')
      .filter({ has: page.locator('button[aria-label^="Session actions for "]') })
  }

  /**
   * Reveal and click a row action, re-hovering if a projection update replaces
   * the row before its hover-only button becomes visible.
   * @param row - the row owning the action.
   * @param name - accessible name of the action button.
   */
  async function clickHoverAction(row: Locator, name: string): Promise<void> {
    const button = row.getByRole('button', { name })
    await expect.poll(async () => {
      await row.hover()
      return await button.isVisible()
    }, { timeout: 10_000 }).toBe(true)
    await button.click()
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // Seed one cold session; with no Workspace registered it is the sidebar's
    // only row outside projects.
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

  it('archives the seed, restores it through the sidebar filter, and keeps it restored across reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-unarchive'))
    // Select the only visible Session, then give it a user-owned title: the
    // locator binds to the seed's own copy on both sides of the round trip.
    const seededRow = ordinaryRows()
    await expect.poll(() => seededRow.count(), { timeout: 10_000 }).toBe(1)
    await seededRow.click()
    await expect.poll(() => seededRow.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')
    const { title } = await scaffold.ctx.sessionController.rename({
      sessionId: SessionId(SEED_ID), title: `Unarchive target ${SEED_ID}`,
    })
    const sessionRow = page.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) })
    await expect.poll(() => sessionRow.count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => sessionRow.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')

    // Archive from the row menu: no confirmation dialog, and losing the only
    // ordinary Session leaves the sidebar with no ordinary row at all.
    await clickHoverAction(sessionRow, `Session actions for ${title}`)
    await page.getByRole('menuitem', { name: 'Archive session' }).click()
    await expect.poll(() => sessionRow.count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => ordinaryRows().count(), { timeout: 10_000 }).toBe(0)
    // Durable on the host: the registry-global set carries the id while the
    // Session log itself stays in persistence untouched.
    expect([...scaffold.ctx.workspaceRegistry.archivedSessionIds]).toEqual([SessionId(SEED_ID)])
    expect((await scaffold.ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id))
      .toContain(SessionId(SEED_ID))

    await page.getByRole('button', { name: 'View options' }).click()
    await page.getByRole('menuitem', { name: 'Show archived', exact: true }).click()
    await expect.poll(() => sessionRow.count(), { timeout: 10_000 }).toBe(1)
    await clickHoverAction(sessionRow, `Session actions for ${title}`)
    await page.getByRole('menuitem', { name: 'Unarchive session' }).click()
    await expect.poll(
      () => [...scaffold.ctx.workspaceRegistry.archivedSessionIds],
      { timeout: 10_000 },
    ).toEqual([])
    await page.getByRole('button', { name: 'View options' }).click()
    await page.getByRole('menuitem', { name: 'Show archived', exact: true }).click()
    await expect.poll(() => sessionRow.count(), { timeout: 15_000 }).toBe(1)

    // Reload: the restored row is rebuilt from the host baseline, so the
    // unarchive was durable and not merely client state.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => sessionRow.count(), { timeout: 15_000 }).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
