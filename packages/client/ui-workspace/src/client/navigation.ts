/** Workspace archive and directory UI capability. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ClientRemote, DirectoryListing, RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ISessions,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  IWorkspaces, WorkspaceId,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

/** Workspace archive and directory operations consumed by Client UI domains. */
export interface UiWorkspace {
  /** Create an independent Session without choosing a project. Concurrent requests share creation. */
  openChat(): Promise<void>
  /**
   * Select a Session and show its Conversation as one UI navigation action.
   * @param sessionId - listed or retained Session to display.
   */
  openSession(sessionId: SessionId): void
  /**
   * Connect a Workspace and open its Session unless a later navigation supersedes it.
   * @param workspaceId - target Workspace.
   * @param beforeOpen - optional synchronous preparation for the selected Session, skipped after supersession.
   * @returns completion; a superseded request may create a Session but does not open it.
   */
  openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void>
  /**
   * Fork a Session and open the child unless a later navigation supersedes it.
   * @param sessionId - source Session.
   * @returns completion; a superseded request leaves its child available without selecting it.
   */
  forkSession(sessionId: SessionId): Promise<void>
  /**
   * Resolve the reusable or newly created blank Session for a Workspace.
   * @param workspaceId - target Workspace.
   * @returns a Session already addressable through the Session Controller.
   */
  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>
  /**
   * Start a New Session flow and navigate to its Session.
   * @param workspaceId - explicit target; absent creates an independent Session.
   */
  startSession(workspaceId?: WorkspaceId): void
  /**
   * Archive a Session. Archiving the current selection replaces it with an
   * independent Session once the archive set includes it, deferring to a
   * navigation the user already started.
   * @param sessionId - Session to archive.
   */
  archiveSession(sessionId: SessionId): Promise<void>
  /**
   * Unarchive a Session, restoring it to its recorded Workspace position.
   * @param sessionId - Session to unarchive.
   */
  unarchiveSession(sessionId: SessionId): Promise<void>
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

/** Automatic landings and the diagnostic that names each one's failure. */
const LANDING_WARNING = {
  startup: 'initial session failed:',
  replacement: 'replacement session failed:',
} as const

/** One automatic landing: the first selection after startup, or an archived current Session's replacement. */
type Landing = keyof typeof LANDING_WARNING

/** Implements Workspace archive and directory UI operations. */
class UiWorkspaceService extends Service implements UiWorkspace {
  private readonly connecting = new Map<WorkspaceId, Promise<SessionId>>()
  private readonly lifetime = new AbortController()
  private chatCreation: Promise<SessionId> | undefined
  /**
   * Automatic landing still owed: the first selection after startup, or the
   * replacement an archived current Session leaves. One attempt consumes it; a
   * user navigation that supersedes an attempt leaves it owed.
   */
  private owedLanding: Landing | null = 'startup'
  /** User navigations inside their in-flight window; an automatic landing defers to every one. */
  private readonly userNavigations = new Set<AbortSignal>()
  /** Guard against the synchronous notification the selection clear below produces. */
  private reconciling = false

  /**
   * @param ctx - Client root Context.
   * @param directoryPicker - the directory-picking Remote namespace.
   * @param workspaces - pure Workspace Controller.
   * @param sessions - pure Session Controller.
   */
  constructor(
    ctx: Context,
    private readonly directoryPicker: ClientRemote['directoryPicker'],
    private readonly workspaces: IWorkspaces,
    private readonly sessions: ISessions,
  ) {
    super(ctx, 'uiWorkspace')
    ctx.effect(() => this.watchNavigation(), 'ui-workspace: Workspace navigation policy')
  }

  async connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId> {
    const workspace = this.workspaces.list.getSnapshot().items
      .find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) {
      throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`)
    }
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined) return inflight

    const archived = this.workspaces.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    for (const id of sessions.ids) {
      const summary = sessions.byId[id]
      if (summary !== undefined && summary.blank && summary.cwd === workspace.path
        && workspace.sessionIds.includes(summary.id)
        && !archived.includes(summary.id)) return summary.id
    }

    const attempt = this.sessions.create({ workspaceId })
      .finally(() => { this.connecting.delete(workspaceId) })
    this.connecting.set(workspaceId, attempt)
    return attempt
  }

  openSession(sessionId: SessionId): void {
    this.sessions.open(sessionId)
    this.ctx.layout.selectPanel(null)
  }

  async openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void> {
    return this.navigate(async (isCurrent) => {
      const sessionId = await this.connectWorkspace(workspaceId)
      if (!isCurrent()) return
      beforeOpen?.(sessionId)
      if (isCurrent()) this.openSession(sessionId)
    })
  }

  async forkSession(sessionId: SessionId): Promise<void> {
    return this.navigate(async (isCurrent) => {
      const childId = await this.sessions.fork({ sessionId, increaseTitle: true })
      if (isCurrent()) this.openSession(childId)
    })
  }

  async openChat(): Promise<void> {
    return this.navigate(async (isCurrent) => {
      const id = await this.createChat()
      if (isCurrent()) this.openSession(id)
    })
  }

  startSession(workspaceId?: WorkspaceId): void {
    const operation = workspaceId === undefined ? this.openChat() : this.openWorkspace(workspaceId)
    void operation.catch((reason: unknown) => { console.warn('new session failed:', reason) })
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.archiveSession(sessionId)
  }

  async unarchiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unarchiveSession(sessionId)
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

  /**
   * Run one user-initiated navigation under a fresh layout generation.
   *
   * The registration covers the whole in-flight window, so an automatic
   * landing defers to a navigation the user already started instead of
   * superseding it. Its settlement re-runs that decision, which keeps the
   * replacement an archived current Session owes when the user's navigation
   * fails.
   * @param run - navigation body; `isCurrent` reports whether a later navigation superseded it.
   * @returns the body's result.
   */
  private async navigate<T>(run: (isCurrent: () => boolean) => Promise<T>): Promise<T> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    this.userNavigations.add(navigation)
    // A superseded navigation outlives its abort while its creation is still
    // pending. Re-decide when the abort lands, so losing the claim releases the
    // landing immediately instead of at that unrelated settlement.
    navigation.addEventListener('abort', () => {
      queueMicrotask(() => { this.reconcileNavigation() })
    })
    try {
      return await run(() => !navigation.aborted)
    } finally {
      this.userNavigations.delete(navigation)
      this.reconcileNavigation()
    }
  }

  /**
   * Whether a navigation the user started is still current. A superseded
   * navigation is dropped rather than counted: it has already lost its claim,
   * even while its own creation is still in flight.
   * @returns true while at least one unaborted user navigation is in flight.
   */
  private hasLiveNavigation(): boolean {
    for (const navigation of this.userNavigations) {
      if (navigation.aborted) this.userNavigations.delete(navigation)
    }
    return this.userNavigations.size > 0
  }

  /** @returns the independent Session a New Session action opens, coalescing concurrent requests. */
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

  /**
   * Decide the automatic landing after every list change and after each user
   * navigation settles: the first selection after startup, or the replacement
   * an archived current Session leaves owed.
   */
  private reconcileNavigation(): void {
    if (this.reconciling || this.lifetime.signal.aborted) return
    this.reconciling = true
    try {
      // An archived current selection has no Conversation left to show. The
      // clear notifies this subscription synchronously, which the guard holds
      // off so the decision below reads the cleared snapshots once.
      if (this.clearArchivedCurrent()) this.owedLanding = 'replacement'
      const sessions = this.sessions.list.getSnapshot()
      if (sessions.current !== undefined) {
        this.owedLanding = null
        return
      }
      const owed = this.owedLanding
      if (owed === null) return
      if (owed === 'startup'
        && (this.workspaces.list.getSnapshot().phase !== 'ready' || sessions.phase !== 'ready')) return
      // A navigation the user already started owns the landing; its settlement
      // re-runs this decision.
      if (this.hasLiveNavigation()) return
      this.owedLanding = null
      this.landIndependently(owed)
    } finally {
      this.reconciling = false
    }
  }

  /**
   * Select an independent Session that no user gesture asked for.
   *
   * Unlike `openChat`, this starts no navigation generation and does not
   * activate the Conversation surface: a navigation or global panel the user
   * already has stays exactly as it is, and this Session is selected behind it.
   * @param owed - the automatic landing this attempt serves.
   */
  private landIndependently(owed: Landing): void {
    void this.createChat().then((id) => {
      if (this.lifetime.signal.aborted) return
      if (this.sessions.list.getSnapshot().current !== undefined) return
      if (this.hasLiveNavigation()) {
        // The user started a navigation while this Session was being created:
        // their outcome wins, and a failure re-owes the landing.
        this.owedLanding ??= owed
        return
      }
      this.sessions.open(id)
    }, (reason: unknown) => {
      // A landing that failed after teardown has no user to report to.
      if (this.lifetime.signal.aborted) return
      console.warn(LANDING_WARNING[owed], reason)
    })
  }

  /** @returns true when an archived current selection was cleared. */
  private clearArchivedCurrent(): boolean {
    const current = this.sessions.list.getSnapshot().current
    if (current === undefined
      || !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)) return false
    this.sessions.clear()
    return true
  }

}

export { UiWorkspaceService }
