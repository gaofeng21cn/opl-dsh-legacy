/**
 * The workspace file-change journal through the services it composes with: the
 * real local `ctx.fs` backend, the real Session log and projection registry, and
 * the plugin's own tool wrapper. Every case states a behavior a user can
 * observe — which workspace files come back, which are refused, and what stays
 * untouched — and dispatches through the real tool pipeline so the wrapper's
 * baseline-then-rescan sequence runs exactly as it does in production.
 *
 * The command-level path (`session.rewind` itself) is covered beside the
 * controller that owns it, so this package keeps no dependency on the API layer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineContentToolFixture, ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as sessionRewindFilesPlugin from '../src/index.ts'
import { FileJournal, hashBlob } from '../src/index.ts'
import type { FileJournalState } from '../src/index.ts'
import { fileJournalProjectionDefinition } from '../src/projection.ts'
import { canonicalWorkspaceRoot, resolveWorkspacePath } from '../src/workspace-scan.ts'

interface Harness {
  readonly ctx: Context
  readonly session: Session
  readonly journal: FileJournal
  /** The agent identity every dispatched call carries. */
  readonly agent: Agent
}

let workspace: string
let blobRoot: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-rewind-ws-'))
  blobRoot = await mkdtemp(join(tmpdir(), 'dsh-rewind-blobs-'))
})
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
  await rm(blobRoot, { recursive: true, force: true })
})

/**
 * Boot the composed journal: real local filesystem, real session log, the real
 * turn-boundary projection, and the plugin under test.
 * @param config - journal bounds for the budget cases.
 * @returns the booted harness.
 */
async function bootJournal(config: ConstructorParameters<typeof FileJournal>[1] = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: workspace })
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(sessionRewindFilesPlugin, { blobRoot, ...config })

  const session = ctx.sessions.create(SessionId('journal-session'), { meta: { cwd: workspace } })
  const agent = { id: session.id, session, status: 'idle', ctx } as unknown as Agent
  return { ctx, session, journal: ctx.fileJournal, agent }
}

/**
 * Register a tool that performs the writes a case needs, through the real
 * registry so the journal's wrapper observes the dispatch.
 * @param ctx - the harness context carrying the tool registry.
 * @param body - the writes the case needs.
 * @param name - the tool name to register under.
 */
function installWritingTool(
  ctx: Context,
  body: (exec: Parameters<Parameters<ToolRuntime['register']>[0]['execute']>[1]) => Promise<void>,
  name = 'fixture_write',
): void {
  ctx.tools.register(defineContentToolFixture({
    name,
    description: 'Test-only tool that performs the writes a case needs.',
    parameters: {},
    async execute(_args, exec) {
      await body(exec)
      return []
    },
  }))
}

/**
 * Run one tool call inside a turn, following the production sequence:
 * `turn/start`, `step/start`, dispatch, `step/end`, `turn/end`.
 * @param harness - the booted harness.
 * @param toolName - the registered tool to dispatch.
 * @param turn - the turn number to open.
 * @returns the turn's number.
 */
async function runToolTurn(harness: Harness, toolName = 'fixture_write', turn = 1): Promise<number> {
  harness.session.append('turn/start', { turn })
  harness.session.append('step/start', { turn, step: 1 })
  await harness.ctx.tools.execute({
    callId: `call-${toolName}-${String(turn)}` as never,
    name: toolName,
    arguments: {},
    agent: harness.agent,
    signal: new AbortController().signal,
  })
  harness.session.append('step/end', { turn, step: 1 })
  harness.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return turn
}

/** Raw text of one workspace file, or undefined when it does not exist. */
async function textOf(relativePath: string): Promise<string | undefined> {
  try {
    return await readFile(join(workspace, relativePath), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Raw bytes of one workspace file, or undefined when it does not exist. */
async function bytesOf(relativePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(join(workspace, relativePath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Whether this host can create a symbolic link at all. Windows refuses without
 * developer mode or an elevated process, and the containment case below is
 * about the walk's behavior rather than that privilege.
 * @returns true when a probe link could be created and removed.
 */
async function canCreateSymlink(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), 'dsh-rewind-symlink-probe-'))
  try {
    await writeFile(join(probe, 'target.txt'), 'x')
    await symlink(join(probe, 'target.txt'), join(probe, 'link.txt'))
    return true
  } catch {
    return false
  } finally {
    await rm(probe, { recursive: true, force: true })
  }
}

/** Resolved once: whether this host grants symbolic-link creation. */
const SYMLINKS_SUPPORTED = await canCreateSymlink()

/**
 * Whether this host keeps canonically equivalent name spellings as two files.
 * A filesystem that answers lookups normalization-insensitively (macOS) stores
 * the second write over the first, so the exact-key case cannot be posed there.
 * @returns true when an NFC and an NFD name coexist as two directory entries.
 */
async function canKeepCanonicalVariantsApart(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), 'dsh-rewind-canonical-probe-'))
  try {
    await writeFile(join(probe, 'caf\u00e9.txt'), 'composed')
    await writeFile(join(probe, 'cafe\u0301.txt'), 'decomposed')
    return (await readdir(probe)).length === 2
  } catch {
    return false
  } finally {
    await rm(probe, { recursive: true, force: true })
  }
}

/** Resolved once: whether canonically equivalent spellings can name two files here. */
const CANONICAL_VARIANTS_DISTINCT = await canKeepCanonicalVariantsApart()

/** Resolved once: whether this host carries POSIX permission bits at all. */
const POSIX_PERMISSIONS = process.platform !== 'win32'

/** The journal projection state the session's log folds to. */
function factsOf(harness: Harness): FileJournalState {
  const state = harness.ctx.sessionProjections.stateOf(harness.session, 'fileJournal')
  if (state === undefined) throw new Error('fileJournal projection is not registered')
  return state
}

describe('path discipline', () => {
  it('refuses a journaled path that could leave the workspace root', () => {
    const escapes = ['../escape.txt', 'a/../../escape.txt', '/etc/passwd', 'C:/Windows/system32', '', './x', 'a//b']
    for (const path of escapes) {
      expect(() => resolveWorkspacePath(workspace, path)).toThrow()
    }
  })

  it('resolves an ordinary nested path inside the root', () => {
    expect(resolveWorkspacePath(workspace, 'src/deep/file.txt')).toBe(join(workspace, 'src', 'deep', 'file.txt'))
  })
})

describe('workspace file journal', () => {
  it('restores a modified file and removes a file the turn created', async () => {
    await writeFile(join(workspace, 'tracked.txt'), 'original')
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async (_exec) => {
      await writeFile(join(workspace, 'tracked.txt'), 'changed by the turn')
      await writeFile(join(workspace, 'created.txt'), 'brand new')
    })
    const turn = await runToolTurn(harness)

    const outcome = await harness.journal.restoreTurn(harness.session, turn)

    expect(outcome.kind).toBe('restored')
    expect(await textOf('tracked.txt')).toBe('original')
    expect(await textOf('created.txt')).toBeUndefined()
    if (outcome.kind !== 'restored') throw new Error('expected a restore')
    expect(outcome.receipt.actions.map(entry => `${entry.action}:${entry.path}`).sort())
      .toEqual(['deleted:created.txt', 'restored:tracked.txt'])
  })

  it('restores a file the turn deleted', async () => {
    await writeFile(join(workspace, 'doomed.txt'), 'must come back')
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async (_exec) => {
      await unlink(join(workspace, 'doomed.txt'))
    })
    const turn = await runToolTurn(harness)

    const outcome = await harness.journal.restoreTurn(harness.session, turn)

    expect(outcome.kind).toBe('restored')
    expect(await textOf('doomed.txt')).toBe('must come back')
  })

  it('restores a rename as the removal of the new path and the return of the old one', async () => {
    await writeFile(join(workspace, 'before.txt'), 'moved content')
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async (_exec) => {
      await rename(join(workspace, 'before.txt'), join(workspace, 'after.txt'))
    })
    const turn = await runToolTurn(harness)

    const outcome = await harness.journal.restoreTurn(harness.session, turn)

    expect(outcome.kind).toBe('restored')
    expect(await textOf('before.txt')).toBe('moved content')
    expect(await textOf('after.txt')).toBeUndefined()
  })

  it('restores non-text content byte for byte', async () => {
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f, 0x0a, 0x00])
    await writeFile(join(workspace, 'blob.dat'), binary)
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async (_exec) => {
      await writeFile(join(workspace, 'blob.dat'), Buffer.from([0x09, 0x09]))
      await writeFile(join(workspace, 'other.dat'), binary)
    })
    const turn = await runToolTurn(harness)

    await harness.journal.restoreTurn(harness.session, turn)

    expect(await bytesOf('blob.dat')).toEqual(binary)
    // The created copy is removed, and its content never had to be interpreted.
    expect(await bytesOf('other.dat')).toBeUndefined()
  })

  it.skipIf(!POSIX_PERMISSIONS)('restores the recorded permission bits of the files it rewrites', async () => {
    await writeFile(join(workspace, 'script.sh'), '#!/bin/sh\necho once\n')
    await chmod(join(workspace, 'script.sh'), 0o755)
    await writeFile(join(workspace, 'tool.sh'), '#!/bin/sh\necho tool\n')
    await chmod(join(workspace, 'tool.sh'), 0o700)
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async (_exec) => {
      // Rewriting in place keeps the script's own mode, so only the restore
      // decides what the rewound file gets.
      await writeFile(join(workspace, 'script.sh'), '#!/bin/sh\necho twice\n')
      await unlink(join(workspace, 'tool.sh'))
    })
    const turn = await runToolTurn(harness)

    const outcome = await harness.journal.restoreTurn(harness.session, turn)

    expect(outcome.kind).toBe('restored')
    expect(await textOf('script.sh')).toBe('#!/bin/sh\necho once\n')
    expect((await stat(join(workspace, 'script.sh'))).mode & 0o777).toBe(0o755)
    // A deleted executable comes back executable, not as a fresh 0644 file.
    expect(await textOf('tool.sh')).toBe('#!/bin/sh\necho tool\n')
    expect((await stat(join(workspace, 'tool.sh'))).mode & 0o777).toBe(0o700)
  })

  it('restores the recorded read-only bit on every host', async () => {
    const locked = join(workspace, 'locked.txt')
    await writeFile(locked, 'original')
    await chmod(locked, 0o444)
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async (_exec) => {
      // What a shell does before rewriting a read-only file.
      await chmod(locked, 0o666)
      await writeFile(locked, 'changed')
    })
    const turn = await runToolTurn(harness)

    const outcome = await harness.journal.restoreTurn(harness.session, turn)

    expect(outcome.kind).toBe('restored')
    expect(await textOf('locked.txt')).toBe('original')
    // Windows maps the write bit to the read-only attribute, so this pins the
    // restore's mode application on both hosts.
    expect((await stat(locked)).mode & 0o777).toBe(0o444)
  })

  it('restores a recorded change whose record carries no permission bits', async () => {
    const before = Buffer.from('original')
    const after = Buffer.from('changed')
    await writeFile(join(workspace, 'legacy.txt'), after)
    const harness = await bootJournal()
    const blob = await harness.journal.store.put(before)
    harness.session.append('file/checkpoint', {
      turn: 1,
      promptSeq: 1 as never,
      workspaceRoot: await canonicalWorkspaceRoot(workspace),
      coveredPaths: 1,
      coveredBytes: before.length,
      unrecorded: [],
      truncated: false,
    })
    harness.session.append('file/change', {
      turn: 1,
      step: 1,
      changes: [{
        path: 'legacy.txt',
        kind: 'modify',
        before: { kind: 'recorded', entry: 'file', blob, size: before.length, verifiable: true },
        after: { kind: 'recorded', entry: 'file', blob: hashBlob(after), size: after.length, verifiable: true },
      }],
      outsideWorkspace: [],
      unrecorded: [],
    })

    const outcome = await harness.journal.restoreTurn(harness.session, 1)

    expect(outcome.kind).toBe('restored')
    expect(await textOf('legacy.txt')).toBe('original')
  })

  it.skipIf(!CANONICAL_VARIANTS_DISTINCT)('keys a path by its exact code units rather than a Unicode normalization', async () => {
    const composed = 'caf\u00e9.txt'
    const decomposed = 'cafe\u0301.txt'
    await writeFile(join(workspace, composed), 'composed original')
    await writeFile(join(workspace, decomposed), 'decomposed original')
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async (_exec) => {
      await writeFile(join(workspace, decomposed), 'decomposed changed')
    })
    const turn = await runToolTurn(harness)

    const outcome = await harness.journal.restoreTurn(harness.session, turn)

    expect(outcome.kind).toBe('restored')
    // The decomposed spelling moved back under its own name; normalizing the
    // journal's keys would have restored the composed sibling instead.
    expect(await textOf(decomposed)).toBe('decomposed original')
    expect(await textOf(composed)).toBe('composed original')
  })

  it('keeps a file the turn never touched byte-identical', async () => {
    await writeFile(join(workspace, 'untouched.txt'), 'not ours to change')
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async (_exec) => {
      await writeFile(join(workspace, 'new.txt'), 'created')
    })
    const turn = await runToolTurn(harness)

    const outcome = await harness.journal.restoreTurn(harness.session, turn)

    expect(outcome.kind).toBe('restored')
    expect(await textOf('untouched.txt')).toBe('not ours to change')
  })

  it('records a write from a tool this plugin was never told about', async () => {
    await writeFile(join(workspace, 'unknown.txt'), 'original')
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async (_exec) => {
      await writeFile(join(workspace, 'unknown.txt'), 'written by an unknown tool')
    }, 'deployment_specific_tool')
    const turn = await runToolTurn(harness, 'deployment_specific_tool')

    const outcome = await harness.journal.restoreTurn(harness.session, turn)

    expect(outcome.kind).toBe('restored')
    expect(await textOf('unknown.txt')).toBe('original')
  })

  it('refuses the whole restore when a recorded file changed again afterwards', async () => {
    await writeFile(join(workspace, 'contested.txt'), 'before the turn')
    await writeFile(join(workspace, 'also-touched.txt'), 'before the turn')
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async (_exec) => {
      await writeFile(join(workspace, 'contested.txt'), 'written by the turn')
      await writeFile(join(workspace, 'also-touched.txt'), 'written by the turn')
    })
    const turn = await runToolTurn(harness)
    // A later edit the restore did not make: rewriting would discard it.
    await writeFile(join(workspace, 'contested.txt'), 'edited by the user afterwards')

    const outcome = await harness.journal.restoreTurn(harness.session, turn)

    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'file-conflict', path: 'contested.txt' })
    // Fail-closed: the other recorded path is untouched too, because the whole
    // plan is verified before the first replacement.
    expect(await textOf('contested.txt')).toBe('edited by the user afterwards')
    expect(await textOf('also-touched.txt')).toBe('written by the turn')
  })

  it('restores a turn that ran no tool as a no-op', async () => {
    const harness = await bootJournal()
    harness.session.append('turn/start', { turn: 1 })
    harness.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const outcome = await harness.journal.restoreTurn(harness.session, 1)

    expect(outcome).toEqual({ kind: 'restored', receipt: { restored: 0, deleted: 0, actions: [] } })
  })

  it('refuses a turn that dispatched a tool without a baseline', async () => {
    const harness = await bootJournal()
    harness.session.append('turn/start', { turn: 1 })
    harness.session.append('step/start', { turn: 1, step: 1 })
    harness.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-unrecorded' as never,
      name: 'fixture_write',
      arguments: '{}',
    })
    harness.session.append('step/end', { turn: 1, step: 1 })
    harness.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const outcome = await harness.journal.restoreTurn(harness.session, 1)

    expect(outcome).toEqual({ kind: 'blocked', reason: 'file-journal-absent' })
  })

  it('refuses a turn whose changed file exceeded the recordable size', async () => {
    const big = 'x'.repeat(4096)
    await writeFile(join(workspace, 'big.txt'), big)
    const harness = await bootJournal({ maxFileBytes: 1024 })
    installWritingTool(harness.ctx, async (_exec) => {
      await writeFile(join(workspace, 'big.txt'), `${big}y`)
    })
    const turn = await runToolTurn(harness)

    const outcome = await harness.journal.restoreTurn(harness.session, turn)

    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'file-unrecoverable', path: 'big.txt' })
    expect(await textOf('big.txt')).toBe(`${big}y`)
  })

  it('refuses a turn whose baseline exceeded the scan budget', async () => {
    await writeFile(join(workspace, 'one.txt'), 'one')
    await writeFile(join(workspace, 'two.txt'), 'two')
    const harness = await bootJournal({ maxEntries: 1 })
    installWritingTool(harness.ctx, async (_exec) => {
      await writeFile(join(workspace, 'one.txt'), 'changed')
    })
    const turn = await runToolTurn(harness)

    const outcome = await harness.journal.restoreTurn(harness.session, turn)

    expect(outcome).toEqual({ kind: 'blocked', reason: 'file-checkpoint-over-budget' })
    expect(await textOf('one.txt')).toBe('changed')
  })

  it('leaves a protected directory alone when nothing in it moved', async () => {
    await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(workspace, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1')
    await writeFile(join(workspace, 'src.txt'), 'original')
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async (_exec) => {
      await writeFile(join(workspace, 'src.txt'), 'changed')
    })
    const turn = await runToolTurn(harness)

    const outcome = await harness.journal.restoreTurn(harness.session, turn)

    expect(outcome.kind).toBe('restored')
    expect(await textOf('src.txt')).toBe('original')
    expect(await textOf('node_modules/pkg/index.js')).toBe('module.exports = 1')
  })

  it('refuses a turn that wrote into an excluded dependency store', async () => {
    await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(workspace, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1')
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async (exec) => {
      // A filesystem tool writing into an excluded store: the walk never
      // recorded this path, so the write is visible but not recoverable.
      const target = await harness.ctx.fs.resolve(join(workspace, 'node_modules', 'pkg', 'index.js'))
      await harness.ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      const written = await harness.ctx.fs.writeText(target, 'module.exports = 2')
      harness.ctx.emit('fs/observed', target, { kind: 'present', version: written.version }, exec)
    })
    const turn = await runToolTurn(harness)

    const outcome = await harness.journal.restoreTurn(harness.session, turn)

    expect(outcome).toMatchObject({
      kind: 'blocked',
      reason: 'file-unrecoverable',
      path: 'node_modules/pkg/index.js',
    })
    expect(await textOf('node_modules/pkg/index.js')).toBe('module.exports = 2')
  })

  it('records and restores ordinary build output, which is not an excluded store', async () => {
    await mkdir(join(workspace, 'dist'), { recursive: true })
    await writeFile(join(workspace, 'dist', 'bundle.js'), 'built once')
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async () => {
      await writeFile(join(workspace, 'dist', 'bundle.js'), 'built twice')
    })
    const turn = await runToolTurn(harness)

    const outcome = await harness.journal.restoreTurn(harness.session, turn)

    expect(outcome.kind).toBe('restored')
    expect(await textOf('dist/bundle.js')).toBe('built once')
  })

  it('refuses a turn that wrote outside the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-rewind-outside-'))
    try {
      const outsideFile = join(outside, 'elsewhere.txt')
      await writeFile(outsideFile, 'before')
      const harness = await bootJournal()
      installWritingTool(harness.ctx, async (exec) => {
        // What a shipped filesystem tool does: announce the resolved target,
        // write it, then report the observation the write produced.
        const target = await harness.ctx.fs.resolve(outsideFile)
        await harness.ctx.waterfall('fs/write-intent', target, exec, () => undefined)
        const written = await harness.ctx.fs.writeText(target, 'written outside')
        harness.ctx.emit('fs/observed', target, { kind: 'present', version: written.version }, exec)
      })
      const turn = await runToolTurn(harness)

      const outcome = await harness.journal.restoreTurn(harness.session, turn)

      expect(outcome).toEqual({ kind: 'blocked', reason: 'file-outside-workspace' })
      expect(await readFile(outsideFile, 'utf8')).toBe('written outside')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(!SYMLINKS_SUPPORTED)('never follows a symlink out of the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-rewind-link-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'outside content')
      await symlink(join(outside, 'secret.txt'), join(workspace, 'link.txt'))
      const harness = await bootJournal()
      installWritingTool(harness.ctx, async (_exec) => {
        await writeFile(join(workspace, 'inside.txt'), 'inside')
      })
      const turn = await runToolTurn(harness)

      const outcome = await harness.journal.restoreTurn(harness.session, turn)

      expect(outcome.kind).toBe('restored')
      // The link and its target are both untouched: a restore removes what the
      // turn created inside the workspace, never what a link points at.
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside content')
      expect(await textOf('link.txt')).toBe('outside content')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses a second restore rather than reverting work done after the first', async () => {
    await writeFile(join(workspace, 'tracked.txt'), 'original')
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async (_exec) => {
      await writeFile(join(workspace, 'tracked.txt'), 'changed')
    })
    const turn = await runToolTurn(harness)

    const first = await harness.journal.restoreTurn(harness.session, turn)
    // Work done after the restore is the caller's to keep.
    await writeFile(join(workspace, 'tracked.txt'), 'written after the restore')
    const second = await harness.journal.restoreTurn(harness.session, turn)

    expect(first.kind).toBe('restored')
    // The path no longer holds the recorded post-turn state, so the plan refuses
    // instead of reverting the newer work.
    expect(second).toEqual({ kind: 'blocked', reason: 'file-conflict', path: 'tracked.txt' })
    expect(await textOf('tracked.txt')).toBe('written after the restore')
  })

  it('rebuilds the same facts from the log alone, as a restarted process would', async () => {
    await writeFile(join(workspace, 'tracked.txt'), 'original')
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async (_exec) => {
      await writeFile(join(workspace, 'tracked.txt'), 'changed')
    })
    const turn = await runToolTurn(harness)

    const live = factsOf(harness)
    expect(live.checkpoints).toHaveLength(1)
    expect(live.batches.at(-1)?.changes.map(change => change.path)).toEqual(['tracked.txt'])

    // A fresh context folding the same events must reach the same facts and be
    // able to restore the turn, which is what a restarted process does.
    const replayed = new Context()
    await replayed.plugin(SessionProjectionRegistry)
    await replayed.plugin(LocalFileSystem, { cwd: workspace })
    replayed.sessionProjections.register(fileJournalProjectionDefinition)
    const replaySession = Session.create(
      harness.session.id,
      harness.session.snapshotEvents(),
      harness.session.header,
    )
    expect(replayed.sessionProjections.stateOf(replaySession, 'fileJournal')).toEqual(live)

    const outcome = await new FileJournal(replayed, { blobRoot }).restoreTurn(replaySession, turn)

    expect(outcome.kind).toBe('restored')
    expect(await textOf('tracked.txt')).toBe('original')
    await replayed.fiber.dispose()
  })

  it('drops live state without forgetting the log records', async () => {
    await writeFile(join(workspace, 'tracked.txt'), 'original')
    const harness = await bootJournal()
    installWritingTool(harness.ctx, async (_exec) => {
      await writeFile(join(workspace, 'tracked.txt'), 'changed')
    })
    const turn = await runToolTurn(harness)

    harness.journal.forget(harness.session)
    const outcome = await harness.journal.restoreTurn(harness.session, turn)

    // Live state is an optimization; the log is the source of truth.
    expect(outcome.kind).toBe('restored')
    expect(await textOf('tracked.txt')).toBe('original')
  })
})
