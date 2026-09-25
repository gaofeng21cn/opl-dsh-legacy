/** Session commands whose activation policy is explicit at each Remote method. */

import { randomUUID, createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { modelAvailable } from './catalog.ts'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentAdmissionPart, FileAttachmentRef, ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import type { FileUploadReceiptId, PromptFileBinding } from '@deepseek-ai/dsh-client-file-upload'
import {
  ReasoningEffortId, assistantStreamChunks, createDeveloperMessage, createUserMessage, freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { isRewindSurfaceEvent, REWIND_SURFACE_PLUGIN } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent, SessionHeader, SessionId, Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { PromptSurfaceProjection } from '@deepseek-ai/dsh-agent'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'
// Type-only: resolves the optional permission service this controller reads and writes.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-rewind-files'
import type { EffectivePermission, PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
  ApiSessionNotFound,
  ApiSessionPresetConflict,
  ApiSessionSubagentOwnership,
  apiSessionSubagentOwnershipError,
  hasApiSessionSubagentOwner,
  inspectApiSession,
} from './agent.ts'
import type {
  PromptContentPart,
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionCreateRequest,
  SessionCreateValue,
  SessionEditPromptRequest,
  SessionEditPromptValue,
  SessionForkRequest,
  SessionForkValue,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionRewindRequest,
  SessionRewindValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionPermissionsRequest,
  SessionPermissionsValue,
  SessionSelectPermissionsRequest,
  SessionSelectPermissionsValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
  SessionRequestId,
} from './types.ts'

/** Sandbox modes ordered from the most confined to the least. */
const SANDBOX_ORDER: readonly EffectivePermission['sandbox'][] = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * Whether installing `target` would grant more than `current` already grants.
 *
 * A wider sandbox mode or an approval policy that stops asking both enlarge
 * what the Session can do without a human in the loop; everything else is a
 * narrowing or an unchanged value.
 * @param current - the effective permission before the switch.
 * @param target - the permission the switch would install.
 * @returns true when the switch widens execution or approval reach.
 */
function widensPermission(current: EffectivePermission, target: EffectivePermission): boolean {
  const widenedSandbox = SANDBOX_ORDER.indexOf(target.sandbox) > SANDBOX_ORDER.indexOf(current.sandbox)
  const widenedApproval = current.approval === 'ask' && target.approval === 'never'
  return widenedSandbox || widenedApproval
}

interface SessionReadState {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

type PromptContentCandidate =
  | SessionPromptRequest['content'][number]
  | Extract<SessionUpdateQueueRequest['action'], { readonly kind: 'edit' }>['content'][number]

function hasPromptContent(content: readonly PromptContentCandidate[]): boolean {
  return content.some(part => part.type !== 'text' || part.text.trim().length > 0)
}

/**
 * Resolve the omitted-`atSeq` default to the latest completed-turn prefix,
 * including standalone events before the next turn begins.
 */
function latestCompletedPrefixBoundary(events: readonly SessionEvent[]): SessionSeq | undefined {
  const lastTurnEnd = events.findLast(event => event.type === 'turn/end')
  if (lastTurnEnd === undefined) return undefined
  let boundary = lastTurnEnd.seq
  for (const next of events.slice(boundary + 1)) {
    if (next.type === 'turn/start' || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced') break
    boundary = next.seq
  }
  return boundary
}

/**
 * Parse one client-addressed prompt seq.
 * @param seq - client-supplied event seq of the addressed user message.
 * @returns the parsed Session seq.
 * @throws RemoteError when the value is not a non-negative safe integer.
 */
function requirePromptSeq(seq: number): SessionSeq {
  try {
    return SessionSeq(seq)
  } catch {
    throw new RemoteError('gateway/bad-request', 'seq must be a non-negative safe integer', {})
  }
}

/**
 * Normalize one failure raised while a prompt was admitted or delivered.
 *
 * A RemoteError already carries the caller-facing reason, an attachment
 * rejection keeps its own code, and anything else is reported as the Agent
 * refusing the prompt.
 * @param error - failure raised by prompt admission or delivery.
 * @throws RemoteError - always; the calling `catch` block does not continue.
 */
function rethrowPromptAdmissionFailure(error: unknown): never {
  if (remoteErrorOf(error) !== undefined) throw error
  if (error instanceof AttachmentError) {
    throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
  }
  throw new RemoteError('session/agent-busy', 'prompt rejected', { reason: String(error) })
}

/** Implements Session business commands delegated by the Session Controller Remote service. */
export class SessionCommandController {
  /**
   * Tail of each Session's in-flight rewind. A rewind mutates durable log state
   * and the workspace, so two concurrent requests for one Session must run in
   * sequence: the second then finds the committed replacement and answers it
   * idempotently instead of appending a second marker or restoring twice.
   */
  private readonly rewindsInFlight = new Map<string, Promise<unknown>>()

  /**
   * @param ctx - Host context carrying Agent, model, attachment, title, and Workspace services.
   * @param agents - sole owner of create, resume, and Session-local model selection.
   * @param defaultCwd - project directory used when create names neither a Workspace nor a cwd.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
    private readonly defaultCwd: string,
    private readonly standaloneRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'tasks'),
  ) {}

  /**
   * Create or idempotently adopt one ordinary Session.
   * @param request - requested identity, location, and Agent preset.
   * @returns the Session identity and resolved preset when configured.
   * @throws RemoteError when the Session cannot be created, or when it was
   *   created but its project membership could not be recorded.
   */
  async create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    if (request.workspaceId !== undefined && request.cwd !== undefined) {
      throw new RemoteError('gateway/bad-request', 'session.create accepts workspaceId or cwd, not both', {})
    }
    // A rejected preset must leave nothing behind, so it is resolved before the
    // Session, its workspace, or its Agent exists.
    if (request.permissionPreset !== undefined) this.resolvePermissionPreset(request.permissionPreset)
    const sessionId = request.sessionId ?? brandString<SessionId>(`session-${randomUUID()}`)
    let workspace: Workspace | undefined
    if (request.workspaceId !== undefined) {
      workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
      if (workspace === undefined) {
        throw new RemoteError('workspace/not-found', `workspace "${request.workspaceId}" not found`, {
          workspaceId: request.workspaceId,
        })
      }
    }
    if (request.standalone && (workspace !== undefined || request.cwd !== undefined)) {
      throw new RemoteError('gateway/bad-request', 'standalone cannot specify a workspace or cwd', {})
    }
    const cwd = request.standalone
      ? join(this.standaloneRoot, createHash('sha256').update(sessionId).digest('hex'))
      : workspace?.path ?? request.cwd ?? this.defaultCwd
    if (request.standalone) await mkdir(cwd, { recursive: true })
    let adopted: Agent
    try {
      adopted = await this.agents.ensureSession(
        sessionId,
        cwd,
        request.sessionId !== undefined,
        request.agentPreset,
      )
    } catch (error) {
      this.rejectCreation(sessionId, error)
    }
    // The Session is registered but has taken no turn: the preset lands before
    // any model request or tool call can resolve a permission.
    if (request.permissionPreset !== undefined) {
      this.selectPermissions({ sessionId: adopted.session.id, preset: request.permissionPreset })
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId, workspaceId: workspace.id },
        )
      }
    } else if (request.cwd !== undefined) {
      // `standalone` and an explicit `cwd` are mutually exclusive (checked
      // above), so reaching here means the caller named a real directory that
      // the Host never adopted for a project.
      await this.joinProjectForCwd(sessionId, request.cwd)
    } else {
      // A `standalone` create and the `defaultCwd` fallback both name no
      // directory the caller chose, so neither infers membership here.
      await this.keepOutsideProjects(sessionId)
    }
    const agentPreset = this.agents.presetForSession(adopted.session)
    return { sessionId, ...(agentPreset === undefined ? {} : { agentPreset }), ...this.permissionOf(adopted.session) }
  }

  /**
   * Join a just-created Session to the project that owns its create-time
   * directory.
   *
   * The join is inferred from the directory alone, so it never fails the
   * create: an unowned directory, one that does not resolve, and a rejected
   * attach all leave the Session outside projects, where the registry's next
   * start adopts it once its directory is owned. No project is created here.
   * @param sessionId - the Session that was just created.
   * @param cwd - the caller-supplied directory stored in its header.
   * @returns resolution after the best-effort join.
   */
  private async joinProjectForCwd(sessionId: SessionId, cwd: string): Promise<void> {
    let workspace: Workspace | undefined
    try {
      workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd)
    } catch (error) {
      this.ctx.logger.warn(
        `session-controller: session "${sessionId}" stayed outside projects because its cwd `
        + `"${cwd}" is not a resolvable directory: ${String(error)}`,
      )
      return
    }
    if (workspace === undefined) return
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      this.ctx.logger.warn(
        `session-controller: session "${sessionId}" stayed outside project "${workspace.id}" `
        + `because the join failed: ${String(error)}`,
      )
    }
  }

  /**
   * Record the create-time decision that a Session belongs to no project.
   *
   * A `standalone` create and the `defaultCwd` fallback name no directory the
   * caller chose, so this is the only point where that decision can be
   * recorded. Recording it as the registry's explicit outside placement keeps
   * it durable: start-time directory adoption skips a placed Session, so a
   * project registered at the private task directory cannot collect it on a
   * later start, while an explicit `moveSession` still overrides the record.
   *
   * The Session already exists, so a failed write rejects the create with
   * `session/membership-unrecorded` rather than reporting success: the
   * placement is the caller's explicit decision, and without it the registry's
   * next start would adopt the Session into whatever project owns its
   * directory. `details.sessionId` names the created Session, so the caller can
   * recover it and retry the placement once storage accepts writes.
   * @param sessionId - the Session that was just created.
   * @returns resolution after the placement write.
   * @throws RemoteError when the placement could not be saved.
   */
  private async keepOutsideProjects(sessionId: SessionId): Promise<void> {
    try {
      await this.ctx.workspaceRegistry.moveSession(sessionId)
    } catch (error) {
      throw new RemoteError(
        'session/membership-unrecorded',
        `session "${sessionId}" was created but its outside-project placement could not be saved: ${String(error)}; retry workspace.moveSession for this sessionId to record it`,
        { sessionId },
      )
    }
  }

  /**
   * Read one attached Session's effective permission and the offered presets.
   * @param request - Session whose permission is read.
   * @returns the effective permission, the catalog, and the driver's activity.
   * @throws RemoteError when the Session is not attached to this Host.
   */
  permissions(request: SessionPermissionsRequest): SessionPermissionsValue {
    return this.permissionValue(this.requireAttachedSession(request.sessionId))
  }

  /**
   * Install one permission preset on an attached Session.
   *
   * A switch that would widen the Session's reach is refused while its driver
   * is running: the next confined call of the active turn would otherwise
   * execute with access the caller never saw approved. Narrowing stays
   * available at any time. A refusal changes nothing and never cancels the
   * turn; the caller waits for the Session to settle or cancels it itself.
   * @param request - Session identity and the preset to install.
   * @returns the permission now effective and when it reaches execution.
   * @throws RemoteError for an unknown preset, a missing permission service, a
   *   busy Session that the switch would widen, or a refused switch.
   */
  selectPermissions(request: SessionSelectPermissionsRequest): SessionSelectPermissionsValue {
    const session = this.requireAttachedSession(request.sessionId)
    const service = this.requirePermissionService()
    const target = this.resolvePermissionPreset(request.preset)
    const effective = service.permissionsOf(session)
    const turn = this.openTurn(session)
    if (this.driverRunning(request.sessionId) && widensPermission(effective, target)) {
      throw new RemoteError(
        'session/permissions-busy',
        `session "${session.id}" is running${turn === null ? '' : ` turn ${String(turn)}`}: switching from "${effective.preset}" to the wider "${request.preset}" is refused while a turn is active; wait for the Session to settle or cancel it, then retry`,
        { sessionId: session.id, preset: request.preset, currentPreset: effective.preset, ...(turn === null ? {} : { turn }) },
      )
    }
    this.applyPermissionPreset(session, request.preset)
    return { permissions: this.permissionValue(session), appliesFrom: 'next-confined-call' }
  }

  /**
   * The permission payload a create response carries, empty without a service.
   * @param session - the created Session.
   * @returns the `permissions` field, or an empty object when unsupported.
   */
  private permissionOf(session: Session): { permissions?: SessionPermissionsValue } {
    return this.ctx.get('permissionPresets') === undefined ? {} : { permissions: this.permissionValue(session) }
  }

  /** Build the full permission value for one attached Session. */
  private permissionValue(session: Session): SessionPermissionsValue {
    const service = this.requirePermissionService()
    const effective = service.permissionsOf(session)
    return {
      sessionId: session.id,
      preset: effective.preset,
      sandbox: effective.sandbox,
      approval: effective.approval,
      available: service.names,
      defaultPreset: service.defaultPreset,
      running: this.driverRunning(session.id),
      turn: this.openTurn(session),
    }
  }

  /** The mounted permission service, or a named failure. */
  private requirePermissionService(): PermissionPresetService {
    const service = this.ctx.get('permissionPresets')
    if (service === undefined) {
      throw new RemoteError('session/permissions-unavailable', 'no permission service is composed on this Host', {
        sessionId: brandString<SessionId>(''), preset: '', reason: 'permission-presets is not mounted',
      })
    }
    return service
  }

  /** Resolve a preset before anything is created or changed. */
  private resolvePermissionPreset(name: string): EffectivePermission {
    const service = this.requirePermissionService()
    try {
      const spec = service.resolve(name)
      return { preset: name, sandbox: spec.sandbox, approval: spec.approval }
    } catch (error) {
      throw new RemoteError(
        'session/permissions-unknown-preset',
        error instanceof Error ? error.message : String(error),
        { preset: name, available: service.names },
      )
    }
  }

  /** Write one validated preset, reporting a refused write as a named failure. */
  private applyPermissionPreset(session: Session, name: string): void {
    const service = this.requirePermissionService()
    try {
      service.set(session, name)
    } catch (error) {
      throw new RemoteError(
        'session/permissions-unavailable',
        `session "${session.id}" permission was not changed: ${error instanceof Error ? error.message : String(error)}`,
        { sessionId: session.id, preset: name, reason: error instanceof Error ? error.message : String(error) },
      )
    }
  }

  /** The attached Session named by `sessionId`, or a named failure. */
  private requireAttachedSession(sessionId: SessionId): Session {
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) {
      throw new RemoteError('session/not-found', `session "${sessionId}" not found (not attached)`, { sessionId })
    }
    return session
  }

  /** Whether the Session's driver is actively running a turn. */
  private driverRunning(sessionId: SessionId): boolean {
    return this.ctx.agents.get(sessionId)?.status === 'running'
  }

  /** The turn open on one Session, or null. */
  private openTurn(session: Session): number | null {
    const state = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (state === undefined || state.openTurnStartSeq === null) return null
    return state.lastTurn
  }

  /**
   * Validate and install one Session-local model selection; save the default in the background.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session, without waiting for default persistence.
   */
  async selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    const agent = await this.resolveAgent(request.sessionId)
    return this.agents.serializeImageAdmission(agent, async () => {
      try {
        await this.requireModel(request)
        const resolved = await this.ctx.llm.resolveCallConfig({
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }),
        })
        const selected: AgentModelSelection = {
          provider: resolved.provider,
          model: resolved.model,
          ...(resolved.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: resolved.reasoningEffort }),
        }
        this.agents.selectForNextRequest(agent, selected)
        void this.ctx.agentDefaultModel.saveSelection(selected).catch((error: unknown) => {
          this.ctx.logger.warn(
            `session-controller: model selection changed for the Session but the default was not saved: ${String(error)}`,
          )
        })
        return { selected: { ...selected } }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'session/model-unavailable',
          error instanceof Error ? error.message : String(error),
          { provider: request.provider, model: request.model },
        )
      }
    })
  }

  /**
   * Normalize and append a user-owned Session title.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  async rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    const agent = await this.resolveAgent(request.sessionId)
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined) {
      throw new RemoteError('gateway/internal', 'renaming is unavailable: this deployment mounts no session-title service', {})
    }
    try {
      const accepted = titles.rename(agent.session, request.title)
      return { title: accepted.title, seq: accepted.eventSeq }
    } catch (error) {
      if (error instanceof SessionTitleInvalidError) {
        throw new RemoteError('session/title-invalid', error.message, { sessionId: request.sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `failed to rename session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
  }

  /**
   * Create a new ordinary Session from an exact event prefix. An explicit
   * `atSeq` is the inclusive cut; an omitted value selects the latest
   * completed-turn prefix. An open cut receives synthetic fork closers.
   * @param request - source Session and optional exact event boundary.
   * @returns the new Session identity.
   */
  async fork(request: SessionForkRequest): Promise<SessionForkValue> {
    let atSeq: ReturnType<typeof SessionSeq> | undefined
    try {
      atSeq = request.atSeq === undefined ? undefined : SessionSeq(request.atSeq)
    } catch {
      throw new RemoteError('gateway/bad-request', 'atSeq must be a non-negative safe integer', {})
    }
    let observed: SessionObservation
    try {
      observed = await this.ctx.sessionQuery.observeSession(request.sessionId)
    } catch (error) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${request.sessionId}" not found`, {
          sessionId: request.sessionId,
        })
      }
      throw new RemoteError(
        'gateway/internal',
        `fork source unavailable for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    using source = observed
    const boundary = atSeq ?? latestCompletedPrefixBoundary(source.events)
    if (boundary === undefined || source.events[boundary]?.seq !== boundary) {
      throw new RemoteError(
        'session/fork-unavailable',
        request.atSeq === undefined
          ? `session "${request.sessionId}" has no completed turn to fork from`
          : `event ${String(request.atSeq)} does not exist in session "${request.sessionId}" (last seq: ${String(source.events.at(-1)?.seq ?? 'none')})`,
        { sessionId: request.sessionId },
      )
    }
    const seed = buildForkSeed(source.events, boundary)
    let workspace: Workspace | undefined
    try {
      workspace = await this.forkWorkspace(source.header)
    } catch (error) {
      throw new RemoteError('gateway/internal', 'fork project lookup failed: ' + String(error), {})
    }
    const childId = brandString<SessionId>(`session-${randomUUID()}`)
    const composition = await this.agents.composeAgent(this.agents.presetForObservation(source))
    try {
      const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
      await this.ctx.agents.create({
        sessionId: childId,
        seed,
        inheritedEventCount: SessionLogOffset(boundary + 1),
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          parentSession: source.header.id,
          isSeeded: true,
          ...(composition.agentPreset === undefined
            ? {}
            : { agentPreset: composition.agentPreset }),
        },
        agentOptions: { provider, model },
        setup: composition.setup,
      })
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to fork session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    if (workspace !== undefined) {
      try {
        await this.ctx.workspaceRegistry.moveSession(childId, workspace.id)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId: childId, workspaceId: workspace.id },
        )
      }
    }
    return { sessionId: childId }
  }

  /**
   * Reject empty content, then admit one prompt after Agent and attachment validation.
   * @param request - Session identity, prompt content, source metadata, and delivery mode.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  async prompt(request: SessionPromptRequest): Promise<SessionPromptValue> {
    if (!hasPromptContent(request.content)) {
      throw new RemoteError(
        'gateway/bad-request',
        'prompt content must include non-whitespace text or an attachment',
        {},
      )
    }
    const clientTimeZone = request.clientTimeZone === undefined
      ? undefined
      : canonicalClientTimeZone(request.clientTimeZone)
    if (request.clientTimeZone !== undefined && clientTimeZone === undefined) {
      throw new RemoteError(
        'session/invalid-time-zone',
        'clientTimeZone must be UTC or a valid IANA Area/Location name',
        { value: request.clientTimeZone },
      )
    }
    const agent = await this.resolveAgent(request.sessionId)
    if (hasPromptRequest(agent, request.requestId)) return { accepted: true }
    await this.requireServedRoute(agent)
    const hasImage = request.content.some(part => part.type === 'image')
    const admit = async (): Promise<SessionPromptValue> => {
      await this.admitAndDeliverPrompt(agent, request.requestId, request.content, clientTimeZone, (message, binding) => {
        if (request.mode === 'steer') agent.steer(message)
        else agent.followup(message)
        binding.commit()
      })
      return { accepted: true }
    }
    return hasImage ? this.agents.serializeImageAdmission(agent, admit) : admit()
  }

  private async requireModel(selection: Pick<AgentModelSelection, 'provider' | 'model'>): Promise<void> {
    if (!await modelAvailable(this.ctx, selection)) {
      throw new RemoteError('session/model-unavailable', 'Select an available model before sending a message.',
        { provider: selection.provider, model: selection.model })
    }
  }

  /**
   * Rewrite the last editable user message and resend it as a new turn.
   *
   * The edited message enters the model-visible surface as a replacement of the
   * branch the addressed prompt opened — the prompt's own node through the
   * current surface tail — so the abandoned assistant and tool output leaves the
   * branch while every original event stays in the log. Everything is validated
   * before the replacement is appended, so a refused edit leaves the log and the
   * inbox untouched.
   * @param request - Session identity, addressed user message, edited content, and source metadata.
   * @returns acknowledgement with the replacement message's durable event seq.
   * @throws RemoteError when the content, the addressed message, the Session
   *   state, or the model route refuses the edit.
   */
  async editPrompt(request: SessionEditPromptRequest): Promise<SessionEditPromptValue> {
    if (!hasPromptContent(request.content)) {
      throw new RemoteError(
        'gateway/bad-request',
        'edited prompt must include non-whitespace text or an attachment',
        {},
      )
    }
    const clientTimeZone = request.clientTimeZone === undefined
      ? undefined
      : canonicalClientTimeZone(request.clientTimeZone)
    if (request.clientTimeZone !== undefined && clientTimeZone === undefined) {
      throw new RemoteError(
        'session/invalid-time-zone',
        'clientTimeZone must be UTC or a valid IANA Area/Location name',
        { value: request.clientTimeZone },
      )
    }
    const { agent, addressed } = await this.resolveAddressedAgent(request.sessionId, request.seq)
    // A retried edit is acknowledged with the replacement that already landed.
    const committed = committedPromptRewrite(promptLedger(this.ctx, agent.session), request.requestId)
    if (committed !== undefined) return { accepted: true, seq: committed }
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(request.sessionId)) {
      throw new RemoteError(
        'session/edit-unavailable',
        `session "${request.sessionId}" is archived`,
        { sessionId: request.sessionId, reason: 'archived' },
      )
    }
    const prompt = lastSurfacePrompt(promptLedger(this.ctx, agent.session))
    if (prompt === undefined) {
      throw new RemoteError(
        'session/edit-unavailable',
        `session "${request.sessionId}" holds no user message to edit`,
        { sessionId: request.sessionId, reason: 'no-user-message' },
      )
    }
    if (prompt.seq !== addressed) {
      throw new RemoteError(
        'session/edit-unavailable',
        `event ${String(request.seq)} is not the last editable user message of session "${request.sessionId}"`,
        { sessionId: request.sessionId, reason: 'not-last' },
      )
    }
    if (agent.status === 'running') {
      throw new RemoteError(
        'session/edit-unavailable',
        `session "${request.sessionId}" is running: the last user message may still be settling`,
        { sessionId: request.sessionId, reason: 'busy' },
      )
    }
    await this.requireServedRoute(agent)
    const hasImage = request.content.some(part => part.type === 'image')
    const admit = async (): Promise<SessionEditPromptValue> => {
      const seq = await this.admitAndDeliverPrompt(
        agent,
        request.requestId,
        request.content,
        clientTimeZone,
        (message, binding) => {
          // Admission awaited, so the branch this edit replaces is re-resolved:
          // a surface that moved cannot be replaced by a stale range.
          const current = lastSurfacePrompt(promptLedger(this.ctx, agent.session))
          if (current === undefined || current.seq !== prompt.seq) {
            throw new RemoteError(
              'session/edit-unavailable',
              `session "${agent.id}" no longer holds event ${String(prompt.seq)} as its last user message`,
              { sessionId: agent.id, reason: current === undefined ? 'no-user-message' : 'not-last' },
            )
          }
          const replacement = agent.session.append('user/message', message, {
            surfaceOp: { op: 'replace', startSeq: current.seq, endSeq: current.endSeq },
            sourceEventSeqs: [...current.shadowedSeqs],
          })
          agent.followup(message)
          binding.commit()
          return replacement.seq
        },
      )
      return { accepted: true, seq }
    }
    return hasImage ? this.agents.serializeImageAdmission(agent, admit) : admit()
  }

  /**
   * Roll the conversation back to the state before its last direct human prompt.
   *
   * The prompt's whole branch — its own surface node through the current tail —
   * leaves the model-visible surface and an empty system node takes its place, so
   * the next request sees exactly the history that preceded the prompt. Every
   * shadowed event stays in the append-only log, and the branch range travels on
   * the replacement (`surfaceOp` plus `sourceEventSeqs`) as rewind metadata.
   * Pending inbox work the rewound turn produced is discarded; pending direct
   * human prompts are kept, because a rewind must not destroy typed input.
   *
   * Only the last direct human prompt of a Session whose turn has closed can be
   * rewound. The command is idempotent on that prompt: a retry whose first
   * attempt already landed returns the committed replacement without touching
   * the log again.
   * @param request - Session identity and the addressed prompt's event seq.
   * @returns the committed replacement, the shadowed surface range, and the discarded queue identities.
   * @throws RemoteError when the addressed prompt, the Session state, or the turn boundary refuses the rewind.
   */
  async rewind(request: SessionRewindRequest): Promise<SessionRewindValue> {
    const previous = this.rewindsInFlight.get(request.sessionId) ?? Promise.resolve()
    // A predecessor's own refusal must not cancel the queued request: it starts
    // from a clean read of the log either way.
    const run = previous.then(
      () => this.rewindOnce(request),
      () => this.rewindOnce(request),
    )
    const tail = run.then(() => undefined, () => undefined)
    this.rewindsInFlight.set(request.sessionId, tail)
    try {
      return await run
    } finally {
      if (this.rewindsInFlight.get(request.sessionId) === tail) {
        this.rewindsInFlight.delete(request.sessionId)
      }
    }
  }

  /**
   * Perform one rewind against the current log. Callers serialize through
   * {@link rewind}, which is what makes a concurrent request idempotent.
   * @param request - Session identity and the addressed prompt's event seq.
   * @returns the committed replacement, the shadowed range, the discarded queue identities, and the restored files.
   * @throws RemoteError when the addressed prompt, the Session state, or the turn boundary refuses the rewind.
   */
  private async rewindOnce(request: SessionRewindRequest): Promise<SessionRewindValue> {
    const { agent, addressed } = await this.resolveAddressedAgent(request.sessionId, request.seq)
    // A retried rewind answers with the replacement that already removed this
    // prompt before any policy check can turn a landed rollback into a reported
    // failure; the effect is a function of the addressed prompt, not the retry.
    const events = (await this.readSessionState(request.sessionId)).events
    const landed = committedRewind(events, addressed)
    if (landed !== undefined) {
      return {
        accepted: true,
        seq: landed.seq,
        shadowedSeqs: [...(landed.sourceEventSeqs ?? [])],
        discarded: [],
        files: [],
      }
    }
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(request.sessionId)) {
      throw new RemoteError(
        'session/rewind-unavailable',
        `session "${request.sessionId}" is archived`,
        { sessionId: request.sessionId, reason: 'archived' },
      )
    }
    const prompt = lastSurfacePrompt(promptLedger(this.ctx, agent.session))
    if (prompt === undefined) {
      throw new RemoteError(
        'session/rewind-unavailable',
        `session "${request.sessionId}" holds no user message to roll back`,
        { sessionId: request.sessionId, reason: 'no-user-message' },
      )
    }
    if (prompt.seq !== addressed) {
      throw new RemoteError(
        'session/rewind-unavailable',
        `event ${String(request.seq)} is not the last user message of session "${request.sessionId}"`,
        { sessionId: request.sessionId, reason: 'not-last' },
      )
    }
    if (agent.status === 'running') {
      throw new RemoteError(
        'session/rewind-unavailable',
        `session "${request.sessionId}" is running: the last turn has not settled`,
        { sessionId: request.sessionId, reason: 'busy' },
      )
    }
    const coordinates = settledTurnCoordinates(events)
    if (coordinates === undefined) {
      throw new RemoteError(
        'session/rewind-unavailable',
        `session "${request.sessionId}" has no closed turn to roll back`,
        { sessionId: request.sessionId, reason: 'turn-open' },
      )
    }
    // A concurrent agent in the same workspace would interleave its writes with
    // the restore, so the rewind refuses instead of racing it.
    const workspaceRoot = agent.session.header.cwd
    if (workspaceRoot !== undefined
      && this.ctx.agents.list().some(other => other !== agent
        && other.status === 'running'
        && other.session.header.cwd === workspaceRoot)) {
      throw new RemoteError(
        'session/rewind-unavailable',
        `another session is running in workspace "${workspaceRoot}"`,
        { sessionId: request.sessionId, reason: 'file-unavailable', fileReason: 'file-workspace-busy' },
      )
    }
    // Restore the turn's recorded workspace writes BEFORE anything durable
    // changes: a refusal must leave both the log and the workspace untouched,
    // and a restore that landed must not be replayed by a retry that then fails.
    const journal = this.ctx.get('fileJournal')
    const restored = journal === undefined
      ? { kind: 'blocked' as const, reason: 'file-journal-absent' as const }
      : await journal.restoreTurn(agent.session, coordinates.turn)
    if (restored.kind === 'blocked') {
      throw new RemoteError(
        'session/rewind-unavailable',
        `session "${request.sessionId}" cannot restore the workspace writes of turn ${String(coordinates.turn)}: ${restored.reason}`
          + (restored.path === undefined ? '' : ` ("${restored.path}")`),
        {
          sessionId: request.sessionId,
          reason: 'file-unavailable',
          fileReason: restored.reason,
          ...restored.path === undefined ? {} : { path: restored.path },
        },
      )
    }
    const discarded = pendingProducedSince(events, prompt.seq, agent.inbox)
    const replacement = agent.session.append('developer/message', {
      turn: coordinates.turn,
      step: coordinates.step,
      message: createDeveloperMessage({ content: [], source: { kind: REWIND_SURFACE_PLUGIN } }),
    }, {
      surfaceOp: { op: 'replace', startSeq: prompt.seq, endSeq: prompt.endSeq },
      sourceEventSeqs: [...prompt.shadowedSeqs],
    })
    for (const message of discarded) agent.inbox.remove(message.id)
    return {
      accepted: true,
      seq: replacement.seq,
      shadowedSeqs: [...prompt.shadowedSeqs],
      discarded: discarded.map(message => message.id),
      files: restored.receipt.actions.map(action => ({ path: action.path, action: action.action })),
    }
  }

  /**
   * Read one durable image after proving the Session log references it.
   * @param request - Session and attachment identities used for authorization.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  async attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    let source: SessionReadState
    try {
      source = await this.readSessionState(request.sessionId)
    } catch (error) {
      if (error instanceof ApiSessionNotFound) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `attachment authorization unavailable for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    const ref = referencedImage(source.events, String(request.attachmentId))
    if (ref === undefined) {
      throw new RemoteError(
        'session/attachment-invalid',
        'Image is not referenced by this session.',
        { reason: 'ATTACHMENT_NOT_REFERENCED' },
      )
    }
    try {
      const stored = await this.ctx.attachments.readImage(ref)
      return {
        attachment: stored.ref,
        data: Buffer.from(stored.data).toString('base64'),
      }
    } catch (error) {
      if (error instanceof AttachmentError) {
        throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
      }
      throw new RemoteError('gateway/internal', 'Unable to read image attachment.', {})
    }
  }

  /**
   * Mutate one pending Inbox occurrence, restoring an ordinary cold Agent when needed.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  async updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue> {
    if (request.action.kind === 'edit') {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Remote callers can submit untyped JSON.
      if (request.action.content.some(block => block.type !== 'text')) {
        throw new RemoteError(
          'session/attachment-invalid',
          'queue edits accept text content only',
          { reason: 'QUEUE_EDIT_NON_TEXT' },
        )
      }
      if (!hasPromptContent(request.action.content)) {
        throw new RemoteError(
          'gateway/bad-request',
          'queue edit content must include non-whitespace text',
          {},
        )
      }
    }
    let agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      const found = await this.agents.resolveAgent(request.sessionId)
      if ('error' in found) {
        if (found.error.code !== 'session/not-found') throw found.error
        throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
      }
      agent = found.agent
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      const identity = this.ctx.sessionProjections
        .snapshot(agent.session, ['subagent'])
        .values.subagent
      if (identity?.mode !== 'continuable'
        || !agent.session.isOwnSeq(identity.seq)) {
        throw apiSessionSubagentOwnershipError(request.sessionId)
      }
    }
    const nextTurn = agent.inbox.nextTurn.find(message => message.id === request.itemId)
    const nextStep = agent.inbox.nextStep.find(message => message.id === request.itemId)
    const located = nextTurn === undefined
      ? nextStep === undefined ? undefined : { target: 'next-step' as const, message: nextStep }
      : { target: 'next-turn' as const, message: nextTurn }
    if (located === undefined) {
      throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
    }
    const { target, message } = located
    if (request.action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
      throw new RemoteError('session/steer-unavailable', 'current turn no longer accepts steering', { itemId: request.itemId })
    }
    switch (request.action.kind) {
      case 'edit':
        agent.inbox.replace(request.itemId, freezeMessage<UserMessage>({
          ...message,
          content: [...request.action.content],
        }))
        break
      case 'remove': {
        agent.inbox.remove(request.itemId)
        const source = message.source
        if (source.kind === 'user' && 'rpcId' in source) {
          this.ctx.fileUploads.retirePrompt(agent, source.rpcId)
        }
        break
      }
      case 'steer':
        agent.inbox.remove(request.itemId)
        agent.steer(message)
        break
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        assertNever(request.action, 'queue action')
    }
    return { accepted: true }
  }

  /**
   * Cancel one live ordinary Agent while retaining pending inbox work.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  cancel(request: SessionCancelRequest): SessionCancelValue {
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      throw new RemoteError(
        'session/not-found',
        `session "${request.sessionId}" not found (not attached)`,
        { sessionId: request.sessionId },
      )
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw apiSessionSubagentOwnershipError(request.sessionId)
    }
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { accepted: true }
  }

  /**
   * Resolve one addressed Session and refuse a caller that does not own it.
   *
   * The addressed commands read one client-named user message, so they share
   * the seq parse, the attach lookup, and the continuable-subagent fence before
   * any command-specific policy runs.
   * @param sessionId - Session the request addressed.
   * @param seq - client-supplied event seq of the addressed user message.
   * @returns the live Agent and the parsed prompt seq.
   * @throws RemoteError when the seq is invalid, the Session is not attached, or a subagent owns it.
   */
  private async resolveAddressedAgent(
    sessionId: SessionId,
    seq: number,
  ): Promise<{ readonly agent: Agent; readonly addressed: SessionSeq }> {
    const addressed = requirePromptSeq(seq)
    const agent = await this.resolveAgent(sessionId)
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw apiSessionSubagentOwnershipError(sessionId)
    }
    return { agent, addressed }
  }

  /**
   * Require a served model route before any prompt is admitted.
   * @param agent - Agent the prompt addresses.
   * @throws RemoteError when no adapter serves the selected provider.
   */
  private async requireServedRoute(agent: Agent): Promise<void> {
    await this.requireModel(this.agents.selectionFor(agent).current)
  }

  /**
   * Admit one prompt's content and deliver it through the caller's own step.
   *
   * `prompt` and `editPrompt` share every step between content and delivery:
   * image support is checked against the selected model, staged receipts are
   * resolved and admitted into one user message, an Agent disposed while
   * admission was awaited is refused, and the upload binding surrounds
   * delivery so a refused prompt restores its receipts.
   * @param agent - Agent that receives the message.
   * @param requestId - client-minted identity recorded on the message and its uploads.
   * @param content - requested content, possibly referencing staged files.
   * @param clientTimeZone - validated client time zone, when the request carried one.
   * @param deliver - the command's own delivery step, receiving the admitted message and its binding.
   * @returns whatever `deliver` returned.
   * @throws RemoteError when the model rejects images, a receipt is unknown, the Agent was disposed, or delivery failed.
   */
  private async admitAndDeliverPrompt<T>(
    agent: Agent,
    requestId: SessionRequestId,
    content: readonly PromptContentPart[],
    clientTimeZone: string | undefined,
    deliver: (message: UserMessage, binding: PromptFileBinding) => T,
  ): Promise<T> {
    const source: MessageSource = {
      kind: 'user',
      rpcId: requestId,
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    }
    try {
      if (content.some(part => part.type === 'image')) {
        const current = this.agents.selectionFor(agent).current
        const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model)
        if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
          throw new RemoteError(
            'session/attachment-invalid',
            `Model "${current.model}" does not support image input.`,
            { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
          )
        }
      }
      const admission = resolvePromptFileReceipts(content, receiptId => this.ctx.fileUploads.resolve(agent, receiptId))
      const admitted = await this.ctx.attachments.admitPromptContent(admission.content)
      const message: UserMessage = createUserMessage({ content: admitted, source })
      if (this.ctx.agents.get(agent.id) !== agent) {
        throw new RemoteError(
          'session/not-found',
          `session "${agent.id}" was disposed during prompt admission`,
          { sessionId: agent.id },
        )
      }
      using binding = this.ctx.fileUploads.bindPrompt(agent, admission.receiptIds, requestId)
      return deliver(message, binding)
    } catch (error) {
      rethrowPromptAdmissionFailure(error)
    }
  }

  private async resolveAgent(sessionId: SessionId): Promise<Agent> {
    const found = await this.agents.resolveAgent(sessionId)
    if ('error' in found) throw found.error
    return found.agent
  }

  private rejectCreation(sessionId: SessionId, error: unknown): never {
    if (remoteErrorOf(error) !== undefined) throw error
    if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
      throw new RemoteError('session/writer-held', error.message, { sessionId })
    }
    if (error instanceof ApiSessionPresetConflict) {
      throw new RemoteError('agent-preset/conflict', error.message, {
        sessionId: error.sessionId,
        requestedPreset: error.requestedPreset,
        ...(error.existingPreset === undefined ? {} : { existingPreset: error.existingPreset }),
      })
    }
    if (error instanceof ApiSessionCwdConflict) {
      throw new RemoteError('session/conflict', error.message, {
        sessionId: error.sessionId,
        requestedCwd: error.requestedCwd,
        ...(error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd }),
      })
    }
    if (error instanceof ApiSessionSubagentOwnership) {
      throw apiSessionSubagentOwnershipError(error.sessionId)
    }
    throw new RemoteError('gateway/internal', `failed to create session "${sessionId}": ${String(error)}`, {})
  }

  private async readSessionState(sessionId: SessionId): Promise<SessionReadState> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      return { id: attached.id, header: attached.header, events: attached.snapshotEvents() }
    }
    const inspected = await inspectApiSession(this.ctx, sessionId)
    return { id: inspected.meta.id, header: inspected.meta, events: inspected.events }
  }

  private async forkWorkspace(source: SessionHeader): Promise<Workspace | undefined> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
    if (direct !== undefined || source.origin !== 'subagent') return direct
    const lineage = await this.ctx.sessionQuery.traceSession(source.id)
    for (const ancestor of lineage.ancestors) {
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id))
      if (workspace !== undefined) return workspace
    }
    return undefined
  }
}

function resolvePromptFileReceipts(
  content: SessionPromptRequest['content'],
  stagedFile: (receiptId: FileUploadReceiptId) => FileAttachmentRef | undefined,
): { readonly content: AttachmentAdmissionPart[]; readonly receiptIds: readonly FileUploadReceiptId[] } {
  const receiptIds = new Set<FileUploadReceiptId>()
  const resolved = content.map((part): AttachmentAdmissionPart => {
    if (part.type !== 'file') return part
    const attachment = stagedFile(part.receiptId)
    if (attachment === undefined) {
      throw new RemoteError(
        'session/attachment-invalid',
        'File was not uploaded for this session.',
        { reason: 'FILE_NOT_STAGED' },
      )
    }
    receiptIds.add(part.receiptId)
    return { type: 'file', attachment }
  })
  return { content: resolved, receiptIds: [...receiptIds] }
}

function hasPromptRequest(agent: Agent, requestId: SessionRequestId): boolean {
  const matches = (message: UserMessage): boolean => {
    const source = message.source
    return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
  }
  if (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)) return true
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return agent.session.snapshotEvents().some((event) => {
    if (event.type !== 'user/message') return false
    const source = event.data.source
    return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
  })
}

/** One current model-visible direct human prompt and the branch its turn opened. */
interface SurfacePrompt {
  /** Event seq of the prompt's own surface node. */
  readonly seq: SessionSeq
  /** Event seq of the current surface tail, the replaced range's last node. */
  readonly endSeq: SessionSeq
  /** Current surface nodes from the prompt through the tail, in surface order. */
  readonly shadowedSeqs: readonly SessionSeq[]
}

/**
 * Read one Session's model-visible prompt ledger.
 *
 * The projection is mandatory state: without it the controller cannot tell
 * which message is editable, and a silent default would rewrite the wrong
 * branch, so the first dependent read fails loud instead of degrading.
 * @param ctx - Host context carrying the Session projection registry.
 * @param session - live Session whose ledger is read.
 * @returns the current surface nodes and direct human prompts.
 * @throws RemoteError when the `promptSurface` projection is not registered.
 */
function promptLedger(ctx: Context, session: Session): PromptSurfaceProjection {
  const ledger = ctx.sessionProjections.stateOf(session, 'promptSurface')
  if (ledger === undefined) {
    throw new RemoteError(
      'gateway/internal',
      `session "${session.id}" has no prompt-surface projection; mount the agent loop before the Session Controller`,
      {},
    )
  }
  return ledger
}

/**
 * Locate the last direct human prompt of one prompt ledger together with the
 * branch it opened: its own node through the surface tail. Synthetic
 * `user/message` events (injected context, goal rounds) carry a non-`user`
 * source and are never editable.
 * @param ledger - the Session's folded prompt ledger.
 * @returns the prompt and its branch, or undefined when the surface holds none.
 */
function lastSurfacePrompt(ledger: PromptSurfaceProjection): SurfacePrompt | undefined {
  const prompt = ledger.prompts.at(-1)
  const endSeq = ledger.nodes.at(-1)
  if (prompt === undefined || endSeq === undefined) return undefined
  const index = ledger.nodes.indexOf(prompt.seq)
  if (index < 0) return undefined
  return { seq: prompt.seq, endSeq, shadowedSeqs: ledger.nodes.slice(index) }
}

/**
 * The branch-replacing message one edit request already committed.
 * @param ledger - the Session's folded prompt ledger.
 * @param requestId - client-minted identity carried by the replacement message.
 * @returns the committed replacement's event seq, or undefined before one landed.
 */
function committedPromptRewrite(
  ledger: PromptSurfaceProjection,
  requestId: SessionRequestId,
): SessionSeq | undefined {
  for (const entry of ledger.prompts) {
    if (entry.replaced && entry.rpcId === requestId) return entry.seq
  }
  return undefined
}

/**
 * The committed rewind replacement that already removed one prompt's branch.
 * Its `sourceEventSeqs` is exactly the shadowed surface range, because the
 * rewind producer cites every shadowed node and nothing else.
 * @param events - durable Session events in log order.
 * @param promptSeq - the addressed prompt's event seq.
 * @returns the committed replacement, or undefined before one landed.
 */
function committedRewind(
  events: readonly SessionEvent[],
  promptSeq: SessionSeq,
): SessionEvent<'system/message'> | undefined {
  return events.findLast(
    (event): event is SessionEvent<'system/message'> =>
      isRewindSurfaceEvent(event) && event.surfaceOp.startSeq <= promptSeq && promptSeq <= event.surfaceOp.endSeq,
  )
}

/**
 * Coordinates the last closed turn ended at, or undefined while one is open.
 *
 * A rewind may only undo a turn that ended: an open turn owns surface nodes the
 * loop is still appending, so replacing its branch would race the writer. The
 * numbers ride the marker node's payload as the coordinates the removal
 * happened at; a turn that entered no step reports step 0.
 * @param events - durable Session events in log order.
 * @returns the closed turn's coordinates, or undefined while a turn is open.
 */
function settledTurnCoordinates(events: readonly SessionEvent[]): { turn: number; step: number } | undefined {
  let turn = 0
  let step = 0
  let open = false
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        turn = event.data.turn
        step = 0
        open = true
        break
      case 'step/start':
      case 'step/end':
        step = event.data.step
        break
      case 'turn/end':
        open = false
        break
      default:
        break
    }
  }
  return open ? undefined : { turn, step }
}

/**
 * Pending inbox work the rewound prompt or its turn admitted.
 *
 * Every inbox mutation is a durable `agent/inbox/spliced` record, so the
 * admission window is the log suffix starting at the rewound prompt. Direct
 * human prompts stay pending even inside that window: they are input the user
 * typed, and the queue's own controls are what remove them.
 * @param events - durable Session events in log order.
 * @param fromSeq - the rewound prompt's event seq.
 * @param inbox - live inbox owning the pending lists.
 * @returns pending messages to discard, in next-step then next-turn order.
 */
function pendingProducedSince(
  events: readonly SessionEvent[],
  fromSeq: SessionSeq,
  inbox: Agent['inbox'],
): UserMessage[] {
  const admitted = new Set<string>()
  for (const event of events) {
    if (event.seq < fromSeq || event.type !== 'agent/inbox/spliced') continue
    for (const message of event.data.inserted) admitted.add(message.id)
  }
  return [...inbox.nextStep, ...inbox.nextTurn]
    .filter(message => admitted.has(message.id) && message.source.kind !== 'user')
}
function imageBlockIn(
  content: unknown,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { readonly type?: unknown; readonly attachment?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ImageAttachmentRef
      if (match(ref)) return ref
    }
  }
  return undefined
}

/** Read only first-party declared content fields; unknown event payloads stay opaque. */
function imageInEvent(
  event: SessionEvent,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  const data = event.data as {
    readonly content?: unknown
    readonly message?: { readonly content?: unknown }
    readonly inserted?: unknown
    readonly summary?: unknown
    readonly rawOutput?: unknown
  }
  // First-party event payloads can be present without their producer plugin mounted.
  const type: string = event.type
  switch (type) {
    case 'user/message':
    case 'tool/ptc-dispatch':
      return imageBlockIn(data.content, match)
    case 'system/message':
    case 'developer/message':
    case 'tool/result':
    case 'team/message/queued':
      return imageBlockIn(data.message?.content, match)
    case 'agent/inbox/spliced': {
      const messages = data.inserted
      if (!Array.isArray(messages)) return undefined
      for (const message of messages as readonly unknown[]) {
        if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
        const found = imageBlockIn((message as { readonly content?: unknown }).content, match)
        if (found !== undefined) return found
      }
      return undefined
    }
    case 'compaction/summary':
      return imageBlockIn(data.summary, match) ?? imageBlockIn(data.rawOutput, match)
    case 'assistant/message': {
      const found = imageBlockIn(data.message?.content, match)
      if (found !== undefined) return found
      break
    }
    case 'assistant/attempt': break
    default: return undefined
  }
  const assistant = event as SessionEvent<'assistant/message' | 'assistant/attempt'>
  for (const chunk of assistantStreamChunks(assistant.data.stream, 'block-end')) {
    const found = imageBlockIn([chunk.block], match)
    if (found !== undefined) return found
  }
  return undefined
}

function referencedImage(
  events: readonly SessionEvent[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  for (const event of events) {
    const found = imageInEvent(event, ref => String(ref.attachmentId) === attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}
