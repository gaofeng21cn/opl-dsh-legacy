/**
 * Windows background children must not open a console window or take focus.
 *
 * Every process the desktop shell starts on its own behalf is a background
 * child: the dsh Host, the bundled pnpm package transactions, and the build
 * helpers. Each is spawned with stdout/stderr piped back to the shell, so a
 * console allocated for it can only appear over the user's window.
 *
 * The confined tool processes are covered separately: `subprocess-local` hides
 * the Windows Job runner, and the restricted-token children inherit that
 * runner's console. Asking for a console of their own would break confinement
 * (STATUS_DLL_INIT_FAILED under the WRITE_RESTRICTED token), so this spec
 * asserts the hide flag and the absence of any console-creating option.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

/** One recorded `spawn` invocation. */
interface SpawnCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: Record<string, unknown>
}

const calls = vi.hoisted(() => [] as SpawnCall[])

// Record the requested options and refuse to start anything: these suites
// assert the spawn contract itself, and a real child would only add timing.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (command: unknown, args: unknown, options: unknown): never => {
      calls.push({
        command: String(command),
        args: Array.isArray(args) ? args.map(String) : [],
        options: { ...(options as Record<string, unknown> | undefined) },
      })
      throw new Error('spawn recorded for the console contract')
    },
  }
})

const { DesktopHostProcess } = await import('../src/host-process.ts')

const roots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-console-'))
  roots.push(root)
  return root
}

afterEach(() => {
  calls.length = 0
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Assert one recorded spawn hides its console and asks for no other. */
function expectBackgroundConsole(run: SpawnCall | undefined): void {
  expect(run).toBeDefined()
  expect(run?.options.windowsHide).toBe(true)
  // `detached` plus a hidden console is not a background child: it is a new
  // process group that Windows may still surface. `CREATE_NEW_CONSOLE` and
  // `CREATE_NO_WINDOW` are the creation flags the restricted-token sandbox
  // must never receive, and Node exposes no option that sets them here.
  expect(run?.options.detached).toBeUndefined()
  expect(run?.options.windowsHide).not.toBe(false)
}

it('hides the dsh Host child the shell owns', async () => {
  const host = new DesktopHostProcess(process.execPath, scratch(), scratch())
  await expect(host.start()).rejects.toThrow('spawn recorded for the console contract')
  expectBackgroundConsole(calls.at(-1))
  expect(calls.at(-1)?.command).toBe(process.execPath)
})
