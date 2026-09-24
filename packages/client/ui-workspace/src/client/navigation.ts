/** Workspace archive and directory UI capability. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ClientRemote, DirectoryListing, RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ISessions,
  SessionCreateError,
  SessionReference,
  SessionTarget,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { RowToast } from './contract/slots.ts'
import { pinOrderAccounts, pinOrderSource } from './pin-order.ts'
import type { WorkspaceViewStoreActions } from './stores.ts'

interface MainSelection {
  readonly sessionId?: SessionId
  readonly subagentAddress?: SubagentAddress
}

/** Workspace archive and directory operations consumed by Client UI domains. */
export interface UiWorkspace {
  /** Create and open an independent Session, coalescing concurrent creation. */
  openChat(): Promise<void>
  /**
   * Select a Session and show its Conversation as one UI navigation action.
   * @param target - known Session identity or durable direct-parent subagent address to display.
   */
  openSession(target: SessionTarget): void
  /**
   * Connect a Workspace and open its Session unless a later navigation supersedes it.
   * @param workspaceId - target Workspace.
   * @param beforeOpen - optional synchronous preparation for the selected Session, skipped after supersession.
   * @returns completion; a superseded request may create a Session but does not open it.
   * @throws on failure; a refused creation is also shown through the Workspace
   * notice unless a later navigation or disposal superseded the request.
   */
  openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void>
  /**
   * Fork a Session without changing the current selection.
   * @param sessionId - source Session.
   * @returns completion after child creation and inherited-title increment.
   */
  forkSession(sessionId: SessionId): Promise<void>
  /**
   * Resolve the reusable or newly created blank Session for a Workspace.
   * @param workspaceId - target Workspace.
   * @returns a Session already addressable through the Session Controller.
   */
  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>
  /**
   * Start a New Session flow and navigate to its Session; a creation the Host
   * refuses is shown through the Workspace notice and leaves the selection as it was.
   * @param workspaceId - explicit target; absent creates an independent Session.
   */
  startSession(workspaceId?: WorkspaceId): void
  /**
   * Archive a Session and replace an archived main selection with an independent Session.
   * @param sessionId - Session to archive.
   * @param options - `stopActivity` asks the Host to stop the Session's running work instead of refusing.
   */
  archiveSession(sessionId: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void>
  /**
   * Unarchive a Session, restoring it to its recorded Workspace position.
   * @param sessionId - Session to unarchive.
   */
  unarchiveSession(sessionId: SessionId): Promise<void>
  /**
   * Pin a Session on the Host, then lead it in its accounts' saved orders
   * (its Workspace group or Ungrouped, and the flat list). The order write
   * reads the memberships current at completion, so reorders that landed
   * while the Host call was pending keep their positions.
   * @param sessionId - Session to pin.
   */
  pinSession(sessionId: SessionId): Promise<void>
  /**
   * Unpin a Session on the Host; saved positions stay as they are.
   * @param sessionId - Session to unpin.
   */
  unpinSession(sessionId: SessionId): Promise<void>
  /**
   * Open the Host-native directory picker.
   * @returns the selected directory, or null when cancelled.
   */
  pickDirectory(): Promise<string | null>
  /**
   * List one Host directory level.
   * @param path - directory path; absent selects the Host home.
   * @param signal - cancellation for a superseded scan.
   * @returns directory entries and breadcrumb ancestry.
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * Create a child directory.
   * @param path - existing parent directory.
   * @param name - child directory name.
   * @returns created absolute path.
   */
  createDirectory(path: string, name: string): Promise<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-Controller Workspace navigation and directory UI capability. */
    uiWorkspace: UiWorkspace
  }
}

/** Structured directory failure exposed to directory UI consumers. */
export class DirectoryBrowseError extends Error {
  override readonly name = 'DirectoryBrowseError'

  /** @param rpcError - Host directory business failure. */
  constructor(readonly rpcError: RemoteFailure) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Implements Workspace archive and directory UI operations. */
class UiWorkspaceService extends Service implements UiWorkspace {
  private readonly connecting = new Map<WorkspaceId, Promise<SessionId>>()
  private readonly lifetime = new AbortController()
  private readonly selection = createSnapshotStore<MainSelection>(
    {}, { persist: { name: 'dsh.sessions.current' } },
  )
  private mainReference: SessionReference | undefined
  private chatCreation: Promise<SessionId> | undefined
  private owedLanding: 'startup' | 'replacement' | null = 'startup'
  private readonly userNavigations = new Set<AbortSignal>()
  private reconciling = false
  private landingInFlight = false

  /**
   * @param ctx - Client root Context.
   * @param directoryPicker - the directory-picking Remote namespace.
   * @param workspaces - pure Workspace Controller.
   * @param sessions - pure Session Controller.
   * @param view - the browser's viewing-store write set (one instance shared with its registration).
   * @param notify - show one notice through the Workspace notice channel.
   */
  constructor(
    ctx: Context,
    private readonly directoryPicker: ClientRemote['directoryPicker'],
    private readonly workspaces: IWorkspaces,
    private readonly sessions: ISessions,
    private readonly view: Pick<WorkspaceViewStoreActions, 'pinSessionOrder'>,
    private readonly notify: (toast: RowToast) => void,
  ) {
    super(ctx, 'uiWorkspace')
    ctx.effect(() => {
      const stop = this.watchNavigation()
      return () => {
        stop()
        this.lifetime.abort()
        const reference = this.mainReference
        this.mainReference = undefined
        reference?.release()
      }
    }, 'ui-workspace: Workspace navigation policy')
  }

  async connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId> {
    const workspace = this.workspaces.list.getSnapshot().items
      .find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) {
      throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`)
    }
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined) return inflight

    const attempt = this.reuseOrCreateBlank(workspace)
      .finally(() => { this.connecting.delete(workspaceId) })
    this.connecting.set(workspaceId, attempt)
    return attempt
  }

  private reuseOrCreateBlank(workspace: WorkspaceView): Promise<SessionId> {
    const archived = this.workspaces.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    for (const id of sessions.ids) {
      const summary = sessions.byId[id]
      if (summary === undefined || !summary.blank || summary.cwd !== workspace.path
        || !workspace.sessionIds.includes(id) || archived.includes(id)) continue
      return this.reuseBlank(workspace.workspaceId, id)
    }
    return this.sessions.create({ workspaceId: workspace.workspaceId })
  }

  private async reuseBlank(workspaceId: WorkspaceId, sessionId: SessionId): Promise<SessionId> {
    try {
      return await this.sessions.create({ workspaceId, sessionId })
    } catch (error: unknown) {
      if (sessionCreateErrorOf(error)?.rpcError.code !== 'session/writer-held') throw error
      return this.sessions.create({ workspaceId })
    }
  }

  openSession(target: SessionTarget): void {
    this.replaceMain(target, this.lifetime.signal, 'reveal')
  }

  async openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void> {
    return this.navigate(async (navigation) => {
      let sessionId: SessionId
      try {
        sessionId = await this.connectWorkspace(workspaceId)
      } catch (error: unknown) {
        if (!navigation.aborted) this.notify({ kind: 'createFailed', message: creationFailureMessage(error) })
        throw error
      }
      if (!navigation.aborted) this.replaceMain(sessionId, navigation, 'reveal', beforeOpen)
    })
  }

  async forkSession(sessionId: SessionId): Promise<void> {
    await this.sessions.fork({ sessionId, increaseTitle: true })
  }

  async openChat(): Promise<void> {
    return this.navigate(async (navigation) => {
      let sessionId: SessionId
      try {
        sessionId = await this.createChat()
      } catch (error: unknown) {
        if (!navigation.aborted) this.notify({ kind: 'createFailed', message: creationFailureMessage(error) })
        throw error
      }
      if (!navigation.aborted) this.replaceMain(sessionId, navigation, 'reveal')
    })
  }

  startSession(workspaceId?: WorkspaceId): void {
    const operation = workspaceId === undefined ? this.openChat() : this.openWorkspace(workspaceId)
    void operation.catch((reason: unknown) => { console.warn('new session failed:', reason) })
  }

  async archiveSession(sessionId: SessionId, options: { readonly stopActivity?: boolean } = {}): Promise<void> {
    await this.workspaces.archiveSession(sessionId, options)
    if (this.mainReference?.sessionId === sessionId) {
      this.clearMain('preserve')
      this.owedLanding = 'replacement'
      this.reconcileNavigation()
    }
  }

  async unarchiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unarchiveSession(sessionId)
  }

  async pinSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.pinSession(sessionId)
    const { items, pinnedSessionIds, archivedSessionIds } = this.workspaces.list.getSnapshot()
    this.view.pinSessionOrder(
      sessionId,
      pinOrderAccounts(items, sessionId),
      pinOrderSource(items, this.sessions.list.getSnapshot(), { pinnedSessionIds, archivedSessionIds }),
    )
  }

  async unpinSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unpinSession(sessionId)
  }

  async pickDirectory(): Promise<string | null> {
    const result = await this.directoryPicker.pick()
    if (!result.ok) throw new Error(`directory picker failed: ${result.error.message}`)
    return result.value
  }

  async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const result = await this.directoryPicker.list(path, signal)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  async createDirectory(path: string, name: string): Promise<string> {
    const result = await this.directoryPicker.createDirectory(path, name)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  /** Run user navigation while an automatic landing defers to its result. */
  private async navigate<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    this.userNavigations.add(navigation)
    navigation.addEventListener('abort', () => {
      queueMicrotask(() => { this.reconcileNavigation() })
    }, { once: true })
    try {
      return await run(navigation)
    } finally {
      this.userNavigations.delete(navigation)
      this.reconcileNavigation()
    }
  }

  private hasLiveNavigation(): boolean {
    for (const navigation of this.userNavigations) {
      if (navigation.aborted) this.userNavigations.delete(navigation)
    }
    return this.userNavigations.size > 0
  }

  private createChat(): Promise<SessionId> {
    return this.chatCreation ??= this.sessions.create({ standalone: true })
      .finally(() => { this.chatCreation = undefined })
  }

  private watchNavigation(): () => void {
    const reconcile = (): void => { this.reconcileNavigation() }
    const disposeWorkspaces = this.workspaces.list.subscribe(reconcile)
    const disposeSessions = this.sessions.list.subscribe(reconcile)
    reconcile()
    return () => {
      this.lifetime.abort()
      disposeSessions()
      disposeWorkspaces()
    }
  }

  private reconcileNavigation(): void {
    if (this.reconciling || this.lifetime.signal.aborted) return
    this.reconciling = true
    try {
      if (this.clearArchivedCurrent()) this.owedLanding = 'replacement'
      if (this.mainReference !== undefined) {
        this.owedLanding = null
        return
      }
      const owed = this.owedLanding
      if (owed === null || this.landingInFlight || this.hasLiveNavigation()) return
      const workspaces = this.workspaces.list.getSnapshot()
      const sessions = this.sessions.list.getSnapshot()
      if (workspaces.phase !== 'ready' || sessions.phase !== 'ready') return
      this.owedLanding = null
      this.landingInFlight = true
      let failed = false
      void this.restoreSelection(owed, sessions).catch((reason: unknown) => {
        failed = true
        if (owed === 'startup' && this.selection.getSnapshot().sessionId !== undefined) this.owedLanding = owed
        if (!this.lifetime.signal.aborted) console.warn(owed === 'startup' ? 'initial Session restoration failed:' : 'replacement Session restoration failed:', reason)
      }).finally(() => {
        this.landingInFlight = false
        if (!failed) this.reconcileNavigation()
      })
    } finally {
      this.reconciling = false
    }
  }

  /** Restore a saved main reference; an absent selection lands outside projects. */
  private async restoreSelection(owed: 'startup' | 'replacement', sessions: SessionListState): Promise<void> {
    const saved = owed === 'startup' ? this.selection.getSnapshot() : {}
    const archived = this.workspaces.list.getSnapshot().archivedSessionIds
    if (saved.subagentAddress !== undefined && !archived.includes(saved.subagentAddress.childSessionId)) {
      this.replaceMain(saved.subagentAddress, this.lifetime.signal, 'preserve')
      return
    }
    const summary = saved.sessionId === undefined ? undefined : sessions.byId[saved.sessionId]
    let sessionId: SessionId
    let navigation = this.lifetime.signal
    if (summary !== undefined && !archived.includes(summary.id)) {
      const workspace = this.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(summary.id))
      if (summary.blank && workspace !== undefined) {
        navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
        sessionId = summary.cwd === workspace.path
          ? await this.reuseBlank(workspace.workspaceId, summary.id)
          : await this.connectWorkspace(workspace.workspaceId)
      } else sessionId = summary.id
    } else {
      sessionId = await this.createChat()
    }
    if (navigation.aborted || this.mainReference !== undefined) return
    if (this.hasLiveNavigation()) {
      this.owedLanding ??= owed
      return
    }
    this.replaceMain(sessionId, this.lifetime.signal, 'preserve')
  }

  /** @returns true when an archived current selection was cleared. */
  private clearArchivedCurrent(): boolean {
    const current = this.mainReference?.sessionId
    if (current === undefined
      || !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)) return false
    this.clearMain('preserve')
    return true
  }

  private clearMain(panel: 'reveal' | 'preserve' = 'reveal'): void {
    const previous = this.mainReference
    this.mainReference = undefined
    this.selection.set({})
    previous?.release()
    if (panel === 'reveal') this.ctx.layout.selectPanel(null)
  }

  private replaceMain(
    target: SessionTarget,
    signal: AbortSignal,
    panel: 'reveal' | 'preserve',
    beforeOpen?: (sessionId: SessionId) => void,
  ): void {
    signal.throwIfAborted()
    const reference = this.sessions.retain(target, { source: 'mainView' })
    try {
      signal.throwIfAborted()
      beforeOpen?.(reference.sessionId)
      if (signal.aborted) {
        reference.release()
        return
      }
      const subagentAddress = typeof target === 'string'
        ? this.sessions.subagentAddress(reference.sessionId)
        : target
      this.selection.set({
        sessionId: reference.sessionId,
        ...(subagentAddress === undefined ? {} : { subagentAddress }),
      })
    } catch (error: unknown) {
      reference.release()
      throw error
    }
    const previous = this.mainReference
    this.mainReference = reference
    previous?.release()
    if (panel === 'reveal') this.ctx.layout.selectPanel(null)
  }

}

/**
 * `error` as the Session Controller's creation failure, or undefined when it
 * is not one. Client plugin bundles do not share error-class identity, so the
 * name decides.
 */
function sessionCreateErrorOf(error: unknown): SessionCreateError | undefined {
  return error instanceof Error && error.name === 'SessionCreateError' ? error as SessionCreateError : undefined
}

/**
 * The words a failed Session creation is reported in: a Host refusal keeps its
 * stable code and message; any other failure keeps its own message.
 */
function creationFailureMessage(error: unknown): string {
  const refused = sessionCreateErrorOf(error)
  if (refused !== undefined) return `${refused.rpcError.code}: ${refused.rpcError.message}`
  return error instanceof Error ? error.message : String(error)
}

export { UiWorkspaceService }
