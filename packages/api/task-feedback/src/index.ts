/**
 * Task feedback: durable registration of dispatched work, a model-free watcher
 * over the bound Sessions, and an outbox that hands one bounded completion
 * notification to the Session that dispatched the task.
 *
 * What this service promises, and what it does not:
 *
 * - A successful transport handoff is sent once; only a refused handoff is
 *   retried. A delivery id is stable per task state, acknowledgments only move
 *   forward, and a repeated notification is a no-op for the receiver. No
 *   exactly-once delivery is claimed, because no transport can make that promise.
 * - A claim has an explicit owner, generation, and lease. `receive` answers
 *   `review` for the first claim, `resume` to the consumer that owns an
 *   unfinished claim, `busy` to a different consumer while the owner's lease is
 *   live, and `skip` after consumption; `consume` rejects a generation the owner
 *   no longer holds. An expired or crashed consumer's claim is reclaimed by a
 *   new generation, which is how an interrupted review is taken over without
 *   racing the consumer that is still working.
 * - A failure recorded as the exact reasoning_text protocol condition gets at
 *   most a configured number of bounded automatic resumes. `resumeFailed`
 *   claims the delivery, verifies the failed turn is still the target, and
 *   submits one persisted user instruction whose request id makes a duplicate
 *   notification or crash replay a no-op; the budget lives on the original
 *   task, so a restart or a retry under a new task id cannot reset it.
 * - A task's state comes from the Session's own durable events. A registered
 *   process exiting is not a completion, and an unreachable Session is
 *   `disconnected`: the task keeps its place and is neither cancelled nor
 *   re-dispatched here.
 * - The watcher never involves a model. It is an event subscription; a caller
 *   whose Host exposes no subscription can bound its own `session.wait`
 *   long-poll instead, which observes the same durable facts.
 * - Only metadata, one summary line, and local evidence references leave this
 *   process. Session output is quoted as untrusted result data, never as an
 *   instruction for the receiver.
 * - This service never answers an approval. A pause is reported and the
 *   Session keeps waiting for its human. The report is structured rather than a
 *   bare state: a needs-input notification carries the bounded questions and
 *   their options, or the approval and its tool, together with the Session the
 *   answer belongs to, so a dispatcher relays the question to its operator
 *   instead of guessing an answer or resuming the Session itself.
 *
 * @module @deepseek-ai/dsh-api-task-feedback
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z as stateSchema } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Type-only bindings: each of these modules publishes the session-event or
// projection declarations this watcher consumes, so importing the binding is
// what merges them into the maps read below.
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionWaitState } from '@deepseek-ai/dsh-api-session-controller'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionItem, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import {
  taskFeedbackDomainSpec,
  type DeliveryRecordState,
  type NeedsInputNoticeState,
  type ReceiptRecordState,
  type TaskRecordState,
} from './spec.ts'
import { codexQueueWakeAdapter, composeWakeMessage, unconnectedWakeAdapter } from './wake.ts'
import type {
  DeliveryRecord,
  DeliveryStage,
  TaskAckRequest,
  TaskAckValue,
  TaskConsumeRequest,
  TaskConsumeValue,
  TaskFlushValue,
  TaskLookupRequest,
  TaskReceipt,
  TaskReceiptStatus,
  TaskReceiveRequest,
  TaskReceiveValue,
  TaskRecord,
  TaskRegistration,
  TaskRegistrationValue,
  TaskResumeAttempt,
  TaskResumeDecision,
  TaskResumeRequest,
  TaskResumeValue,
  TaskState,
  WakeAdapter,
  WakeStatus,
} from './types.ts'

export type * from './types.ts'
export {
  codexQueueWakeAdapter,
  composeWakeMessage,
  unconnectedWakeAdapter,
  WAKE_UNCONNECTED_REASON,
} from './wake.ts'
export type { BoundedProcessResult, WakeCommand, WakeExecutionConfig } from './wake.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable task feedback registry and its notification outbox. */
    taskFeedback: TaskFeedbackService
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'task-feedback/not-found': { readonly taskId: string }
    'task-feedback/delivery-not-found': { readonly taskId: string; readonly deliveryId: string }
    'task-feedback/receipt-not-found': { readonly taskId: string; readonly deliveryId: string }
    'task-feedback/stale-claim': { readonly taskId: string; readonly deliveryId: string; readonly claimEpoch: number }
    'task-feedback/resume-unavailable': { readonly taskId: string }
    'task-feedback/resume-submit-failed': { readonly taskId: string; readonly requestId: string }
  }
}

/** Deployment policy for the feedback loop. */
export interface Config {
  /** Cap on the summary line one delivery carries. */
  readonly summaryMaxChars: number
  /** Attempts one delivery may make before it stops being scheduled. */
  readonly maxDeliveryAttempts: number
  /** Base of the capped exponential retry delay, in milliseconds. */
  readonly retryBaseMs: number
  /** Upper bound on one retry delay, in milliseconds. */
  readonly retryMaxMs: number
  /**
   * Whether the service schedules delivery itself. A deployment that drives the
   * outbox from its own scheduler turns this off and calls `flush` instead.
   */
  readonly autoDeliver: boolean
  /** Maximum duration of one transport attempt. */
  readonly sendTimeoutMs: number
  /**
   * Task states that produce a notification. The default wakes the paid model
   * only for an outcome or a pause: `completed`, `failed`, `waiting_approval`,
   * and `waiting_input`. `queued`, `accepted`, `running`, `cancelled`, and
   * `disconnected` are observed but never notified unless a deployment adds
   * them here, because a progress state is not something a reviewer acts on.
   */
  readonly notifyStates: TaskState[]
  /** Transport used to reach the target Session. */
  readonly wakeTransport: 'unconnected' | 'codex-queue'
  /** Launch the codex executable directly, or inside a WSL distribution. */
  readonly wakeExecution: 'native' | 'wsl'
  /** Codex executable: an absolute path, or a name resolved through `PATH`. */
  readonly wakeExecutable: string
  /** WSL distribution the executable lives in; required by `wakeExecution: wsl`. */
  readonly wakeDistro: string
  /**
   * Automatic resumes one original dispatched task may submit. The count is
   * persisted on the task, so a restart or a retry registered under a new
   * task id cannot reset it. `0` disables automatic resume.
   */
  readonly maxAutoResumes: number
  /**
   * How long a receiver's claim stays live before another consumer may reclaim
   * an unfinished review. A consumer that presents its own identity again needs
   * no reclaim; a different consumer waits out the lease, which is how a
   * crashed receiver's claim is taken over without racing a working one.
   */
  readonly claimLeaseMs: number
  /** Cap on one question, option label, option description, or tool name a needs-input notice carries. */
  readonly needsInputMaxChars: number
  /** Cap on the questions one needs-input notice carries. */
  readonly needsInputMaxQuestions: number
  /** Cap on the options one question may carry. */
  readonly needsInputMaxOptions: number
}

/** The states in which a task still accepts new observations. */
const OPEN_STATES: readonly TaskState[] = [
  'queued', 'accepted', 'running', 'waiting_approval', 'waiting_input', 'disconnected',
]

/** The states that notify by default: an outcome or a pause a reviewer acts on. */
const DEFAULT_NOTIFY_STATES: readonly TaskState[] = [
  'completed', 'failed', 'waiting_approval', 'waiting_input',
]

/** Stage order, so an acknowledgment can only move a delivery forward. */
const STAGE_ORDER: readonly DeliveryStage[] = ['enqueued', 'delivered', 'received', 'review-started']

/** Receipt order, so a repeated or older claim cannot move consumption backwards. */
const RECEIPT_ORDER: readonly TaskReceiptStatus[] = ['received', 'review-started', 'consumed']

/** Longest tail of deciding event positions one evidence record keeps. */
const EVIDENCE_EVENT_LIMIT = 8

/**
 * The exact protocol failure the bounded automatic resume handles.
 *
 * A failure qualifies only when the provider reported an HTTP 400
 * invalid-request whose message states that `reasoning_text` must be passed
 * back. A summary that merely mentions the token is not enough.
 */
const REASONING_TEXT_STATUS = 400
const REASONING_TEXT_CODE = 'INVALID_REQUEST'
const REASONING_TEXT_TOKEN = /\breasoning_text\b/i
const REASONING_TEXT_PASSBACK = /must be passed back/i

/**
 * The user instruction one automatic resume submits.
 *
 * It is a real model-visible user message recorded in the Session log, so the
 * resumed turn is auditable; it names the protocol failure and forbids the two
 * things that would falsify recovery: repeating committed tool calls and
 * fabricating the missing reasoning. Model selection and thinking state are
 * left to the Session's existing configuration.
 */
const AUTO_RESUME_PROMPT = [
  'Automatic protocol recovery: the previous turn was interrupted by the provider error',
  '"reasoning_text must be passed back", which cannot be retried as the same request.',
  'Continue the task from the last committed step. Do not repeat tool calls that already',
  'completed, do not fabricate the missing reasoning, and do not restart the task.',
].join(' ')

/**
 * Whether one recorded turn end is the bounded automatic-resume condition.
 * @param reason - the loop's durable `turn/end` reason.
 * @returns true only for an HTTP 400 invalid-request failure that states reasoning_text must be passed back.
 */
function isReasoningTextProtocolFailure(reason: TurnEndReason | null | undefined): boolean {
  if (reason === null || reason === undefined || reason.kind !== 'error') return false
  const failure = reason.error
  if (failure.status !== REASONING_TEXT_STATUS) return false
  if (failure.code.toUpperCase() !== REASONING_TEXT_CODE) return false
  return REASONING_TEXT_TOKEN.test(failure.message) && REASONING_TEXT_PASSBACK.test(failure.message)
}

/**
 * Build the pattern for one tool-invocation tag name, in either spelling an
 * endpoint emits: the bare tag and the DSML wrapper around it.
 * @param names - alternation of wire tag names this family covers.
 * @returns the pattern matching either spelling.
 */
function toolTag(names: string): RegExp {
  return new RegExp(`<\\s*\\/?\\s*(?:[｜|]\\s*DSML\\s*[｜|]\\s*)?(?:${names})\\b`, 'i')
}

/**
 * Tool-invocation markup a model can leave in visible text when its structured
 * call never formed.
 *
 * Only tool-invocation syntax counts. A `thinking` delimiter in visible text is
 * a symptom the wire diagnostic reports, but it does not falsify a completion
 * the way an invocation nothing executed does, and an ordinary answer quoting
 * prose is not a candidate at all. The turn's own last assistant message is the
 * only text read, so markup mentioned in an earlier step of a turn that went on
 * to call tools normally cannot mark that turn's outcome.
 */
const LEAKED_TOOL_SYNTAX_FAMILIES: readonly { readonly family: string; readonly pattern: RegExp }[] = [
  { family: 'dsml', pattern: /[｜|]\s*DSML\s*[｜|]/i },
  { family: 'invoke-tag', pattern: toolTag('invoke') },
  { family: 'parameter-tag', pattern: toolTag('parameter') },
  { family: 'tool-calls-tag', pattern: toolTag('tool_calls?|function_calls?|calls') },
]

/**
 * Tool-invocation families present in one assistant message's visible text.
 * @param content - the message content blocks as recorded.
 * @returns the stable family names found, in declaration order and without duplicates.
 */
function leakedToolSyntaxFamilies(content: SessionEvent<'assistant/message'>['data']['message']['content']): string[] {
  const text = content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  return LEAKED_TOOL_SYNTAX_FAMILIES.filter(entry => entry.pattern.test(text)).map(entry => entry.family)
}

/** Recorded request identities and final visible diagnostics needed after resume. */
interface FeedbackSessionFacts {
  readonly openTurn: number | null
  readonly pendingInstructions: readonly string[]
  readonly instructions: Readonly<Record<string, { readonly seq: number; readonly turn: number | null }>>
  readonly finalToolSyntax: Readonly<Record<string, readonly string[]>>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    taskFeedbackFacts: FeedbackSessionFacts
  }
}

const feedbackSessionFacts: ProjectionDefinition<'taskFeedbackFacts', FeedbackSessionFacts> = {
  key: 'taskFeedbackFacts',
  stateVersion: 1,
  stateSchema: stateSchema.object({
    openTurn: stateSchema.number().int().nonnegative().nullable(),
    pendingInstructions: stateSchema.array(stateSchema.string()),
    instructions: stateSchema.record(stateSchema.string(), stateSchema.object({
      seq: stateSchema.number().int().nonnegative(),
      turn: stateSchema.number().int().nonnegative().nullable(),
    })),
    finalToolSyntax: stateSchema.record(stateSchema.string(), stateSchema.array(stateSchema.string())),
  }),
  init: (): FeedbackSessionFacts => ({ openTurn: null, pendingInstructions: [], instructions: {}, finalToolSyntax: {} }),
  apply: (state: FeedbackSessionFacts, event: SessionEvent): FeedbackSessionFacts => {
    switch (event.type) {
      case 'turn/start': {
        const instructions = { ...state.instructions }
        for (const requestId of state.pendingInstructions) {
          const instruction = instructions[requestId]
          if (instruction !== undefined) instructions[requestId] = { ...instruction, turn: event.data.turn }
        }
        return { ...state, openTurn: event.data.turn, instructions, pendingInstructions: [] }
      }
      case 'turn/end':
        return { ...state, openTurn: null }
      case 'user/message': {
        const source = event.data.source
        if (source.kind !== 'user' || !('rpcId' in source) || !source.rpcId.startsWith('task-feedback-resume:')) return state
        if (Object.hasOwn(state.instructions, source.rpcId)) return state
        return {
          ...state,
          instructions: { ...state.instructions, [source.rpcId]: { seq: Number(event.seq), turn: state.openTurn } },
          pendingInstructions: state.openTurn === null ? [...state.pendingInstructions, source.rpcId] : state.pendingInstructions,
        }
      }
      case 'assistant/message':
        return {
          ...state,
          finalToolSyntax: { ...state.finalToolSyntax, [String(event.data.turn)]: leakedToolSyntaxFamilies(event.data.message.content) },
        }
      default:
        return state
    }
  },
}

/**
 * The summary of a turn that completed with tool protocol syntax in its text.
 * @param families - the marker families found.
 * @returns the one-line summary a notification carries.
 */
function unverifiedCompletionSummary(families: readonly string[]): string {
  return 'the turn completed, but its final text carries tool syntax nothing executed '
    + `(${families.join(', ')}): the business outcome is not verified`
}

/** The state, summary, and delivery facts one recorded turn end settles. */
interface TurnSettlement {
  readonly state: Extract<TaskState, 'completed' | 'failed' | 'cancelled'>
  readonly summary: string
  readonly resumeEligible: boolean
  readonly leakedToolSyntax: readonly string[] | null
}

/**
 * Whether two recorded marker-family lists describe the same observation.
 * @param left - one stored list, or null.
 * @param right - the list just derived, or null.
 * @returns true when both are absent or name the same families in order.
 */
function sameFamilies(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return left === right
  return left.length === right.length && left.every((family, index) => family === right[index])
}


/**
 * The original dispatched task one record belongs to, treating a record an
 * earlier build wrote as its own root.
 * @param record - the stored task.
 * @returns the root task id.
 */
function rootTaskIdOf(record: TaskRecordState): string {
  return record.rootTaskId ?? record.taskId
}

/**
 * Stable durable identity of the user instruction one attempt submits, so a
 * duplicate notification or a crash replay presents the same request id.
 * @param rootTaskId - original dispatched task the attempt belongs to.
 * @param attempt - one-based attempt number.
 * @returns the branded request id carried by the submitted user message.
 */
function resumeRequestIdOf(rootTaskId: string, attempt: number): SessionRequestId {
  return brandString<SessionRequestId>(`task-feedback-resume:${rootTaskId}:${String(attempt)}`)
}

/**
 * Stable identity of one structured-question pause.
 *
 * The caller-provided question ids name the questions, so a replay of one
 * request yields the same identity; the log cursor separates a genuinely new
 * ask that reuses an id in a later turn from that replay. Identities are the
 * durable key of a waiting delivery, so they never depend on object identity or
 * on the accident of the log having advanced.
 * @param seq - Session log cursor the request was observed at.
 * @param questions - the request's questions, in caller order.
 * @returns the identity string carried by this pause.
 */
function questionObservationKey(seq: number, questions: readonly AskUserQuestionItem[]): string {
  return `${String(seq)}:${questions.map(question => question.id).join('|')}`
}

/**
 * One bounded single-line rendering of caller-supplied pause text.
 *
 * Question text, option labels, and tool names are written by a caller and read
 * by the receiving model, so collapsing every whitespace run is what keeps one
 * field on one line: without it, a question could inject text that reads as one
 * of the notification's own framing lines. The cap bounds the whole notice.
 * @param text - the caller's text.
 * @param maxChars - cap on the returned line, excluding the truncation marker.
 * @returns the collapsed, capped line.
 */
function boundedLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars)}…`
}

/**
 * The questions one pause notice carries, bounded in count, options, and text.
 * @param questions - the request's questions, in caller order.
 * @param maxQuestions - cap on the questions carried.
 * @param maxOptions - cap on the options one question carries.
 * @param maxChars - cap on each rendered text field.
 * @returns the bounded questions.
 */
function boundedQuestions(
  questions: readonly AskUserQuestionItem[],
  maxQuestions: number,
  maxOptions: number,
  maxChars: number,
): NeedsInputNoticeState['questions'] {
  return questions.slice(0, maxQuestions).map(question => ({
    id: question.id,
    question: boundedLine(question.question, maxChars),
    header: question.header === undefined ? null : boundedLine(question.header, maxChars),
    options: (question.options ?? []).slice(0, maxOptions).map(option => ({
      label: boundedLine(option.label, maxChars),
      description: option.description === undefined ? null : boundedLine(option.description, maxChars),
    })),
    multiSelect: question.multiSelect === true,
    intent: question.intent?.kind ?? null,
  }))
}

/**
 * Whether one recorded user message is the automatic-resume instruction with
 * the given deterministic identity.
 * @param event - one committed Session event.
 * @param requestId - instruction identity the attempt submitted.
 * @returns true when this event is that exact instruction.
 */
function isResumeInstruction(event: SessionEvent, requestId: string): boolean {
  if (event.type !== 'user/message') return false
  const source = event.data.source
  return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
}

/**
 * Map a recorded turn end onto the task state it settles.
 * @param reason - the loop's durable `turn/end` reason.
 * @returns the terminal task state for that reason.
 */
function settledState(reason: TurnEndReason): Extract<TaskState, 'completed' | 'failed' | 'cancelled'> {
  switch (reason.kind) {
    case 'completed':
      return 'completed'
    case 'aborted':
      return 'cancelled'
    default:
      // `error`, `blocked`, `max-tokens`, `interrupted`, and any reason a plugin
      // adds all end the turn without completing: the task failed, and calling
      // that success would be the one wrong answer.
      return 'failed'
  }
}

/**
 * One dispatched task's follow-up notification outbox.
 *
 * Mount it where the dispatched Sessions run. A deployment whose transport
 * cannot reach a target leaves the default adapter in place: deliveries then
 * stay `enqueued` and `wake()` reports the missing capability instead of a
 * success.
 */
export default class TaskFeedbackService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessions', 'sessionProjections']

  static Config: z<Partial<Config>, Config> = z.object({
    summaryMaxChars: z.number().step(1).min(1).default(500),
    maxDeliveryAttempts: z.number().step(1).min(1).default(5),
    retryBaseMs: z.number().step(1).min(1).default(1_000),
    retryMaxMs: z.number().step(1).min(1).default(60_000),
    autoDeliver: z.boolean().default(true),
    sendTimeoutMs: z.number().step(1).min(1).default(10_000),
    notifyStates: z.array(z.union([
      z.const('queued'), z.const('accepted'), z.const('running'),
      z.const('waiting_approval'), z.const('waiting_input'),
      z.const('completed'), z.const('failed'), z.const('cancelled'), z.const('disconnected'),
    ])).default([...DEFAULT_NOTIFY_STATES]),
    wakeTransport: z.union([z.const('unconnected'), z.const('codex-queue')]).default('unconnected'),
    wakeExecution: z.union([z.const('native'), z.const('wsl')]).default('native'),
    wakeExecutable: z.string().default(''),
    wakeDistro: z.string().default(''),
    maxAutoResumes: z.number().step(1).min(0).default(2),
    claimLeaseMs: z.number().step(1).min(1).default(600_000),
    needsInputMaxChars: z.number().step(1).min(1).default(500),
    needsInputMaxQuestions: z.number().step(1).min(1).default(8),
    needsInputMaxOptions: z.number().step(1).min(1).default(12),
  })

  private taskTable?: KvTable<string, TaskRecordState>
  private outboxTable?: KvTable<string, DeliveryRecordState>
  private receiptTable?: KvTable<string, ReceiptRecordState>
  private counters?: DomainGlobal<{ deliveryCount: number }>
  /** Replaced from Config during init; the refusing default keeps `wake()` honest before then. */
  private adapter: WakeAdapter = unconnectedWakeAdapter()
  /** Durable writes the watcher started but has not finished. */
  private readonly writing = new Set<Promise<unknown>>()
  /** Authoritative in-memory task view; the write chain follows it. */
  private readonly live = new Map<string, TaskRecordState>()
  /**
   * Turn open on each Session, from the live event feed. It is how a submitted
   * resume instruction is bound to the turn that claimed it: the instruction is
   * recorded inside that turn, after its `turn/start`.
   */
  private readonly openTurns = new Map<string, number>()
  /**
   * Serialized delivery passes. Every pass — the scheduled one and an explicit
   * `flush` — chains onto this promise, so two callers can never send one
   * delivery at the same time.
   */
  private passes: Promise<unknown> = Promise.resolve()
  /** The single pending wake-up, or undefined when none is armed. */
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Delay of the armed wake-up, so a nearer deadline replaces a later one. */
  private timerDueMs: number | undefined
  /** Set on disposal: no wake-up is armed and no new pass starts. */
  private closed = false
  private commits: Promise<unknown> = Promise.resolve()
  private readonly stopping = new AbortController()
  private writeFailure: unknown

  /** Serialize storage updates without holding the lock during transport. */
  private commit<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.commits.then(operation, operation)
    this.commits = run.then(() => undefined, () => undefined)
    return run
  }

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'taskFeedback')
  }

  /** Open the domain, install the model-free watcher, and recover prior state. */
  protected async [Service.init](): Promise<void> {
    this.ctx.sessionProjections.register(feedbackSessionFacts)
    const domain = await this.ctx.storageDomain.open(taskFeedbackDomainSpec)
    this.ctx.effect(() => async () => {
      await this.stopDelivery()
      await domain.close()
    }, 'taskFeedback.close')
    this.taskTable = domain.table('tasks')
    this.outboxTable = domain.table('outbox')
    this.receiptTable = domain.table('receipts')
    for (const [taskId, record] of this.taskTable.entries()) this.live.set(taskId, record)
    this.counters = domain.global
    // Resolved before any transport attempt: a misconfigured entry fails the
    // load instead of silently refusing every delivery later.
    this.adapter = this.buildAdapter()
    this.ctx.effect(() => {
      const offEvents = this.ctx.on('session/event', (session, event) => { this.observe(session, event) }, { global: true })
      // A Session attached after this Host started (a restored or seeded one)
      // publishes no per-event feed for the history it loads with, so its
      // recorded turn end has to be read from the attach edge itself.
      const offCreated = this.ctx.on('session/created', (session: Session) => { this.reconcileAttached(session) }, { global: true })
      // Observation only: answering with `next()` leaves a composing
      // deployment's own answerer to handle the question untouched.
      const offQuestions = this.ctx.on('user-questions/request', (
        request: AskUserQuestionRequestEvent,
        next: () => Promise<AskUserQuestionAnswer>,
      ) => {
        this.observeQuestion(request.agent?.session, request.questions)
        return next()
      }, { global: true })
      return () => { offEvents(); offCreated(); offQuestions() }
    }, 'taskFeedback.watch()')
    // An upgraded deployment stops owing notifications for states the current
    // policy does not notify, so prior `running` entries are not re-attempted.
    await this.retireUnnotified()
    // Disposal cancels the pending wake-up and waits for the pass already
    // running, so an unload cannot leave a delivery half-attempted.
    await this.recover()
    // Recovery schedule: what the outbox still owes is attempted without an
    // external call, because the caller that dispatched the task may be waiting
    // for exactly that notification.
    this.scheduleDelivery(0)
  }

  /**
   * Resolve the configured wake transport, failing the load on a missing entry.
   * @returns the adapter built from Config.
   * @throws when `codex-queue` lacks an executable, or `wsl` lacks a distribution.
   */
  private buildAdapter(): WakeAdapter {
    if (this.config.wakeTransport === 'unconnected') return unconnectedWakeAdapter()
    const executable = this.config.wakeExecutable.trim()
    if (executable === '') {
      throw new Error('task-feedback: wakeExecutable is required when wakeTransport is codex-queue')
    }
    const distro = this.config.wakeDistro.trim()
    if (this.config.wakeExecution === 'wsl' && distro === '') {
      throw new Error('task-feedback: wakeDistro is required when wakeExecution is wsl')
    }
    if (this.config.wakeExecution === 'native' && distro !== '') {
      throw new Error('task-feedback: wakeDistro is only valid when wakeExecution is wsl')
    }
    return codexQueueWakeAdapter({
      execution: this.config.wakeExecution,
      executable,
      distro,
      timeoutMs: this.config.sendTimeoutMs,
    })
  }

  /**
   * Retire pending deliveries for states this policy does not notify.
   *
   * This is the upgrade path for an outbox an older build wrote: a `running`
   * entry that was never acknowledged stops being scheduled instead of being
   * re-sent at the next attempt. Retirement is not an acknowledgment, so the
   * delivery reports that it was retired rather than received.
   */
  private async retireUnnotified(): Promise<void> {
    for (const [deliveryId, record] of [...this.requireOutbox().entries()]) {
      if (record.retired || record.acknowledged) continue
      if (this.config.notifyStates.includes(record.payload.state)) continue
      await this.commit(async () => {
        const latest = this.requireOutbox().get(deliveryId)
        if (latest === undefined || latest.retired || latest.acknowledged) return
        if (this.config.notifyStates.includes(latest.payload.state)) return
        await this.requireOutbox().put(deliveryId, {
          ...latest,
          retired: true,
          nextAttemptAt: null,
          updatedAt: this.now(),
        })
      })
    }
  }

  /**
   * Install the transport that hands notifications to target Sessions.
   * @param adapter - the transport, replacing the refusing default.
   */
  setWakeAdapter(adapter: WakeAdapter): void {
    this.adapter = adapter
    this.scheduleDelivery(0)
  }

  /**
   * Wait for every durable write the watcher has started.
   *
   * The watcher cannot be awaited from a Session event, so this is the point a
   * caller (or the flush below) observes a quiescent registry.
   * @returns nothing once no write is outstanding.
   */
  async settled(): Promise<void> {
    while (this.writing.size > 0) await Promise.allSettled([...this.writing])
    // oxlint-disable-next-line typescript/only-throw-error -- rethrows the write failure exactly as the durable layer raised it.
    if (this.writeFailure !== undefined) throw this.writeFailure
  }

  /**
   * Register one dispatched task, durably and idempotently.
   *
   * Re-registering the same `taskId` returns the stored task unchanged: the id
   * is the caller's idempotency key, so a retried dispatch never doubles a task
   * or its notifications.
   * @param request - identity, bound Session and turn, target, acceptance, and cursor.
   * @returns the stored task.
   * @throws RemoteError when the request cannot describe a watchable task.
   */
  @Remote('register')
  async register(request: TaskRegistration): Promise<TaskRegistrationValue> {
    this.requireRegistration(request)
    const existing = this.requireTasks().get(request.taskId)
    if (existing !== undefined) return { task: this.project(existing) }
    const session = this.ctx.sessions.get(request.sessionId)
    const now = this.now()
    const turn = request.turn ?? null
    const lineage = this.resolveLineage(request)
    // A task registered while its own turn is already open is running now, not
    // waiting for a turn that already started.
    const running = turn !== null && session !== undefined && this.openTurnOf(session) === turn
    const record: TaskRecordState = {
      taskId: request.taskId,
      sessionId: request.sessionId,
      turn,
      target: request.target,
      acceptance: request.acceptance,
      fromSeq: request.fromSeq ?? (session === undefined ? 0 : Number(session.seq)),
      state: session === undefined ? 'queued' : running ? 'running' : 'accepted',
      summary: session === undefined
        ? 'registered; the bound Session is not attached to this Host'
        : running ? `registered; turn ${String(turn)} is already open` : 'registered; waiting for the task turn',
      evidence: { sessionId: request.sessionId, turn: request.turn ?? null, seq: null, eventSeqs: [] },
      waitKey: null,
      needsInput: null,
      // A `turn: null` task settles on the first turn that ends after it was
      // registered; recording the end already on the log is what keeps a turn
      // that finished before registration from settling it later.
      lastEndTurnAtRegistration: turn === null ? this.lastEndTurnOf(session) : null,
      parentTaskId: lineage.parentTaskId,
      rootTaskId: lineage.rootTaskId,
      attempt: lineage.attempt,
      // An attempt added to an existing lineage mirrors the root's budget, so a
      // retried registration cannot reset what the original already spent.
      autoResumeCount: lineage.autoResumeCount,
      autoResumeLimit: lineage.autoResumeLimit,
      resumeEligible: false,
      leakedToolSyntax: null,
      resumeRequestId: null,
      resumeInstructionSeq: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.requireTasks().put(record.taskId, record)
    this.live.set(record.taskId, record)
    return { task: this.project(record) }
  }

  /**
   * Resolve the attempt lineage one registration declares.
   *
   * A retry registered under a new task id points at its parent or directly at
   * the original task, which is how the automatic-resume budget stays attached
   * to the original dispatch.
   */
  private resolveLineage(request: TaskRegistration): {
    parentTaskId: string | null
    rootTaskId: string
    attempt: number
    autoResumeCount: number
    autoResumeLimit: number
  } {
    const parentId = request.parentTaskId ?? request.rootTaskId
    if (parentId === undefined) {
      return {
        parentTaskId: null,
        rootTaskId: request.taskId,
        attempt: 1,
        autoResumeCount: 0,
        autoResumeLimit: this.config.maxAutoResumes,
      }
    }
    const parent = this.requireTasks().get(parentId)
    if (parent === undefined) {
      throw new RemoteError(
        'task-feedback/not-found',
        `no task ${JSON.stringify(parentId)} to attach retry ${JSON.stringify(request.taskId)} to`,
        { taskId: parentId },
      )
    }
    return {
      parentTaskId: request.parentTaskId ?? parent.taskId,
      rootTaskId: parent.rootTaskId ?? parent.taskId,
      attempt: parent.attempt + 1,
      autoResumeCount: this.admittedResumeCount(parent.rootTaskId ?? parent.taskId),
      autoResumeLimit: parent.autoResumeLimit,
    }
  }

  /**
   * Read one task.
   * @param request - the caller's task identity.
   * @returns the stored task.
   * @throws RemoteError when no such task is registered.
   */
  @Remote('task')
  task(request: TaskLookupRequest): TaskRecord {
    return this.project(this.requireTask(request.taskId))
  }

  /**
   * List every registered task in registration order.
   * @returns the stored tasks.
   */
  @Remote('tasks')
  tasks(): readonly TaskRecord[] {
    return [...this.live.values()].map(record => this.project(record))
  }

  /**
   * List the notification outbox in insertion order.
   * @returns every stored delivery.
   */
  @Remote('outbox')
  deliveries(): readonly DeliveryRecord[] {
    return [...this.requireOutbox().entries()].map(([, record]) => record)
  }

  /**
   * Probe whether the configured wake executable can start.
   *
   * The status is the adapter's bounded probe result, not a configured
   * constant: an adapter that cannot start its executable reports
   * `not-connected` with what the probe observed. `executable-started` means
   * exactly that and no more: the probe cannot prove that a target thread exists
   * or that a queued message reaches it.
   * @returns the adapter identity, the probed status, and the observed detail.
   */
  @Remote('wake')
  async wake(): Promise<WakeStatus> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, this.config.sendTimeoutMs)
    timer.unref()
    try {
      const result = await this.adapter.probe(controller.signal)
      return result.started
        ? { adapter: this.adapter.id, status: 'executable-started', detail: result.detail }
        : { adapter: this.adapter.id, status: 'not-connected', reason: result.detail }
    } catch (error) {
      return {
        adapter: this.adapter.id,
        status: 'not-connected',
        reason: `wake probe failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Acknowledge one delivery at the stage the receiving Session reports.
   *
   * Acknowledging an earlier stage again, or acknowledging a delivery twice,
   * changes nothing: the stage is monotonic. This is delivery progress only;
   * the receiver's separate consumption ledger is what makes a repeated review
   * avoidable, so a receiver should claim through {@link receive} first.
   * @param request - delivery identity and the reported stage.
   * @returns the delivery as it now stands.
   * @throws RemoteError when the delivery is unknown or belongs to another task.
   */
  @Remote('ack')
  async ack(request: TaskAckRequest): Promise<TaskAckValue> {
    return this.commit(async () => {
      const value = await this.acknowledge(request)
      // Keep the consumption ledger consistent with an acknowledgment that did
      // not come through `receive`, so `consume` works on either path.
      if (!value.delivery.retired) await this.recordReceipt(request.taskId, request.deliveryId, request.stage)
      return value
    })
  }

  /**
   * Claim one delivery for review, with an explicit owner and lease.
   *
   * This is the receiver's entry point. It durably records the claim and its
   * owner before the review starts and answers what to do with a message that
   * arrives again. A first claim asks for a review; a consumer that owns an
   * unfinished claim is answered `resume`; a different consumer facing a live
   * claim is answered `busy`, so it does not start a second review; a claim
   * whose lease expired is reclaimed by the new consumer, which is how a
   * crashed receiver's work is taken over. A finished claim is answered `skip`.
   * Duplicates are therefore decided from the durable ledger and its ownership,
   * never from whether a second message arrived.
   * @param request - the delivery and the receiving consumer's stable identity.
   * @returns the next action and the durable receipt behind it.
   * @throws RemoteError when the delivery is unknown, retired, or another task's.
   */
  @Remote('receive')
  async receive(request: TaskReceiveRequest): Promise<TaskReceiveValue> {
    return this.commit(async () => this.claim(request))
  }

  /**
   * List the receiver's consumption ledger.
   *
   * A receiver that restarts reads this to find claims it never finished:
   * every entry whose status is not `consumed` is a review still owed, and
   * re-claiming it answers `resume` rather than starting a second one.
   * @returns every receipt, in insertion order.
   */
  @Remote('receipts')
  receipts(): readonly TaskReceipt[] {
    return [...this.requireReceipts().entries()].map(([, record]) => this.projectReceipt(record))
  }

  /**
   * Mark one claimed delivery consumed after its review finished.
   *
   * This is the last step of the receiver's flow and the only state that makes
   * a repeated message answer `skip`. The claim generation is checked, so a
   * consumer whose claim was reclaimed by a newer owner cannot finish a review
   * that owner now holds.
   * @param request - the delivery whose review finished and the claim it was given.
   * @returns the receipt as it now stands.
   * @throws RemoteError when no claim exists, or the caller no longer owns it.
   */
  @Remote('consume')
  async consume(request: TaskConsumeRequest): Promise<TaskConsumeValue> {
    return this.commit(async () => ({ receipt: this.projectReceipt(await this.markConsumed(request)) }))
  }

  /**
   * Submit at most one bounded automatic resume for an eligible failure.
   *
   * One call performs the whole deterministic flow: claim the failure delivery,
   * confirm the failed turn is still the target, and either submit one durable
   * user instruction in the original Session or report why it must not. A
   * duplicate notification or a crash replay presents the same attempt and
   * request id, so at most one instruction is submitted per attempt.
   * @param request - the failure delivery and the receiving consumer's identity.
   * @returns the decision, why it was reached, and the new attempt when one was submitted.
   * @throws RemoteError when the delivery is unknown, or the resume surface is not mounted.
   */
  @Remote('resumeFailed')
  async resumeFailed(request: TaskResumeRequest): Promise<TaskResumeValue> {
    return this.commit(async () => this.resumeFailure(request))
  }

  /** Apply the receiver's claim inside the durable-update queue. */
  private async claim(request: TaskReceiveRequest): Promise<TaskReceiveValue> {
    const stored = this.requireDelivery(request)
    const receipts = this.requireReceipts()
    const existing = receipts.get(request.deliveryId)
    const now = Date.now()
    const consumerId = request.consumerId ?? this.mintConsumerId()
    if (existing === undefined) {
      const receipt = await this.createClaim(stored, consumerId, now)
      const acknowledged = await this.acknowledge({ taskId: request.taskId, deliveryId: request.deliveryId, stage: 'received' })
      return { action: 'review', receipt: this.projectReceipt(receipt), delivery: acknowledged.delivery }
    }
    if (existing.status === 'consumed') {
      const acknowledged = await this.acknowledge({ taskId: request.taskId, deliveryId: request.deliveryId, stage: 'review-started' })
      return { action: 'skip', receipt: this.projectReceipt(existing), delivery: acknowledged.delivery }
    }
    // An ownerless receipt is one an `ack` path wrote; the first `receive`
    // adopts it instead of leaving the review unowned forever.
    const owned = existing.ownerId !== null
    const sameOwner = owned && request.consumerId !== undefined && existing.ownerId === request.consumerId
    const leaseLive = existing.leaseExpiresAt !== null && Date.parse(existing.leaseExpiresAt) > now
    if (sameOwner || !owned || !leaseLive) {
      const receipt = sameOwner
        ? await this.refreshClaim(existing, now)
        : await this.reclaimClaim(existing, consumerId, now)
      const acknowledged = await this.acknowledge({
        taskId: request.taskId,
        deliveryId: request.deliveryId,
        stage: existing.status === 'received' ? 'received' : 'review-started',
      })
      return { action: 'resume', receipt: this.projectReceipt(receipt), delivery: acknowledged.delivery }
    }
    // Another consumer holds a live claim: repair the delivery stage only, and
    // never hand this message permission to work.
    const acknowledged = await this.acknowledge({ taskId: request.taskId, deliveryId: request.deliveryId, stage: 'received' })
    return { action: 'busy', receipt: this.projectReceipt(existing), delivery: acknowledged.delivery }
  }

  /** Move one receipt to `consumed`, checking the claim generation the caller holds. */
  private async markConsumed(request: TaskConsumeRequest): Promise<ReceiptRecordState> {
    const receipt = this.requireReceipts().get(request.deliveryId)
    if (receipt === undefined || receipt.taskId !== request.taskId) {
      throw new RemoteError(
        'task-feedback/receipt-not-found',
        `no receipt ${JSON.stringify(request.deliveryId)} for task ${JSON.stringify(request.taskId)}`,
        { taskId: request.taskId, deliveryId: request.deliveryId },
      )
    }
    if (receipt.status === 'consumed') return receipt
    const stale = receipt.claimEpoch !== request.claimEpoch
      || (request.consumerId !== undefined && receipt.ownerId !== null && receipt.ownerId !== request.consumerId)
    if (stale) {
      throw new RemoteError(
        'task-feedback/stale-claim',
        `claim ${String(request.claimEpoch)} for delivery ${JSON.stringify(request.deliveryId)} was superseded by ${String(receipt.claimEpoch)}`,
        { taskId: request.taskId, deliveryId: request.deliveryId, claimEpoch: request.claimEpoch },
      )
    }
    const next: ReceiptRecordState = { ...receipt, status: 'consumed', updatedAt: this.now() }
    await this.requireReceipts().put(next.deliveryId, next)
    return next
  }

  /** The stored delivery a claim names, or the named failure. */
  private requireDelivery(request: TaskReceiveRequest): DeliveryRecordState {
    const stored = this.requireOutbox().get(request.deliveryId)
    // A retired delivery was never handed to a receiver, so there is no claim
    // to make for it and no review to run.
    if (stored === undefined || stored.taskId !== request.taskId || stored.retired) {
      throw new RemoteError(
        'task-feedback/delivery-not-found',
        `no delivery ${JSON.stringify(request.deliveryId)} for task ${JSON.stringify(request.taskId)}`,
        { taskId: request.taskId, deliveryId: request.deliveryId },
      )
    }
    return stored
  }

  /** Create the first receipt for one delivery, owned by this consumer. */
  private async createClaim(stored: DeliveryRecordState, ownerId: string, now: number): Promise<ReceiptRecordState> {
    const receipt: ReceiptRecordState = {
      deliveryId: stored.deliveryId,
      taskId: stored.taskId,
      status: 'received',
      ownerId,
      claimEpoch: 1,
      leaseExpiresAt: this.leaseUntil(now),
      resumeAttempt: null,
      resumeRootTaskId: null,
      resumeRequestId: null,
      resumeTaskId: null,
      resumeFromSeq: null,
      resumeLastEndTurnAtRegistration: null,
      resumeSubmitted: false,
      claimedAt: this.now(),
      updatedAt: this.now(),
    }
    await this.requireReceipts().put(receipt.deliveryId, receipt)
    return receipt
  }

  /** Extend the lease of a claim the same consumer still owns. */
  private async refreshClaim(existing: ReceiptRecordState, now: number): Promise<ReceiptRecordState> {
    const next: ReceiptRecordState = { ...existing, leaseExpiresAt: this.leaseUntil(now), updatedAt: this.now() }
    await this.requireReceipts().put(next.deliveryId, next)
    return next
  }

  /** Take over an ownerless or expired claim with a new generation. */
  private async reclaimClaim(existing: ReceiptRecordState, ownerId: string, now: number): Promise<ReceiptRecordState> {
    const next: ReceiptRecordState = {
      ...existing,
      ownerId,
      claimEpoch: existing.claimEpoch + 1,
      leaseExpiresAt: this.leaseUntil(now),
      updatedAt: this.now(),
    }
    await this.requireReceipts().put(next.deliveryId, next)
    return next
  }

  /** An owner identity for a consumer that did not name one. */
  private mintConsumerId(): string {
    return `ephemeral:${String(Date.now())}:${Math.random().toString(36).slice(2)}`
  }

  /** The lease deadline for a claim taken at `now`. */
  private leaseUntil(now: number): string {
    return new Date(now + this.config.claimLeaseMs).toISOString()
  }

  /**
   * Create or advance one receipt, never moving it backwards.
   *
   * This is the lower-level `ack` path: it records consumption progress without
   * taking ownership, so a later `receive` adopts the claim.
   * @param taskId - the task the delivery belongs to.
   * @param deliveryId - the delivery being consumed.
   * @param status - the consumption status now observed.
   * @returns the receipt as stored.
   */
  private async recordReceipt(taskId: string, deliveryId: string, status: TaskReceiptStatus): Promise<ReceiptRecordState> {
    const receipts = this.requireReceipts()
    const now = this.now()
    const existing = receipts.get(deliveryId)
    if (existing === undefined) {
      const created: ReceiptRecordState = {
        deliveryId,
        taskId,
        status,
        ownerId: null,
        claimEpoch: 0,
        leaseExpiresAt: null,
        resumeAttempt: null,
        resumeRootTaskId: null,
        resumeRequestId: null,
        resumeTaskId: null,
        resumeFromSeq: null,
        resumeLastEndTurnAtRegistration: null,
        resumeSubmitted: false,
        claimedAt: now,
        updatedAt: now,
      }
      await receipts.put(deliveryId, created)
      return created
    }
    if (RECEIPT_ORDER.indexOf(status) <= RECEIPT_ORDER.indexOf(existing.status)) return existing
    const next: ReceiptRecordState = { ...existing, status, updatedAt: now }
    await receipts.put(deliveryId, next)
    return next
  }

  /**
   * The deterministic automatic-resume decision and submission.
   *
   * The failure delivery is claimed under the identity that already owns its
   * receipt when the caller did not name one, so claiming and recovery share one
   * consumer identity. An admitted attempt whose instruction already reached the
   * Session replays idempotently; one whose submission was never observed
   * re-validates the failure before submitting, so a stale admission cannot
   * append a continuation after a manual turn started. A fresh admission is
   * committed by the receipt write, which is also the budget ledger, so a lost
   * task-record write cannot make one attempt spend budget twice.
   */
  private async resumeFailure(request: TaskResumeRequest): Promise<TaskResumeValue> {
    const claimed = await this.claim(this.resumeClaimRequest(request))
    if (claimed.action === 'skip') {
      return this.resumeDecision('consumed', 'this delivery was already handled', claimed, null)
    }
    if (claimed.action === 'busy') {
      return this.resumeDecision('busy', 'another consumer holds a live claim on this delivery', claimed, null)
    }
    const receipt = this.requireReceipts().get(request.deliveryId)
    if (receipt === undefined) throw new Error('task-feedback: the claim just created is missing')
    const task = this.requireTask(request.taskId)
    const delivery = this.requireOutbox().get(request.deliveryId)
    if (delivery === undefined) throw new Error('task-feedback: the claimed delivery is missing')
    const root = this.requireTasks().get(task.rootTaskId ?? task.taskId) ?? task
    if (receipt.resumeAttempt !== null) {
      // A submission already present in the Session log or its live inbox stands
      // even if a manual turn has since started, so replay it without
      // re-validating. An admission whose submission was never observed must
      // re-validate, because the failure may have been replaced meanwhile.
      if (this.instructionSubmitted(receipt)) {
        const attempt = await this.finishResumeAttempt(root, task, receipt)
        return this.resumeDecision(
          'resumed',
          `attempt ${String(receipt.resumeAttempt)} was already admitted for this delivery`,
          claimed,
          attempt,
        )
      }
      const replayRefusal = this.refuseResume(task, delivery)
      if (replayRefusal !== null) return this.resumeDecision(replayRefusal.decision, replayRefusal.reason, claimed, null)
      const attempt = await this.finishResumeAttempt(root, task, receipt)
      return this.resumeDecision('resumed', `completed the admitted attempt ${String(attempt.attempt)}`, claimed, attempt)
    }
    const refusal = this.refuseResume(task, delivery)
    if (refusal !== null) return this.resumeDecision(refusal.decision, refusal.reason, claimed, null)
    const rootTaskId = rootTaskIdOf(root)
    const used = this.admittedResumeCount(rootTaskId)
    if (used >= root.autoResumeLimit) {
      return this.resumeDecision(
        'budget-exhausted',
        `the original task already used ${String(used)} of ${String(root.autoResumeLimit)} automatic resumes`,
        claimed,
        null,
      )
    }
    const resumeIndex = used + 1
    // The observation point is captured before the instruction is submitted and
    // persisted with the admission, so a delayed registration observes the
    // resumed turn from here instead of from whatever cursor recovery runs at.
    const session = this.ctx.sessions.get(task.sessionId)
    const admittedReceipt: ReceiptRecordState = {
      ...receipt,
      resumeAttempt: resumeIndex,
      resumeRootTaskId: rootTaskId,
      resumeRequestId: resumeRequestIdOf(rootTaskId, resumeIndex),
      resumeTaskId: `${rootTaskId}#r${String(resumeIndex)}`,
      resumeFromSeq: session === undefined ? null : Number(session.seq),
      resumeLastEndTurnAtRegistration: this.lastEndTurnOf(session),
      resumeSubmitted: false,
      updatedAt: this.now(),
    }
    // This one write is the admission commit point and the budget entry. A
    // failure here admits nothing, so a replay retries the same index instead of
    // double-spending; a failure after it cannot lose the admission.
    await this.requireReceipts().put(admittedReceipt.deliveryId, admittedReceipt)
    const admittedRoot = await this.cacheResumeCount(root, resumeIndex)
    const attempt = await this.finishResumeAttempt(admittedRoot, task, admittedReceipt)
    return this.resumeDecision('resumed', `submitted attempt ${String(attempt.attempt)} for the original task`, claimed, attempt)
  }

  /**
   * The claim one resume presents: the caller's identity, or the identity a
   * receipt already records for this delivery.
   * @param request - the resume request as the receiver sent it.
   * @returns a claim request whose consumer identity matches the existing claim.
   */
  private resumeClaimRequest(request: TaskResumeRequest): TaskReceiveRequest {
    if (request.consumerId !== undefined) return request
    const owner = this.requireReceipts().get(request.deliveryId)?.ownerId
    return owner === null || owner === undefined ? request : { ...request, consumerId: owner }
  }

  /**
   * Automatic resumes the receipt ledger records for one original task.
   *
   * This is the authoritative budget read: each admitted failure delivery wrote
   * one receipt, so counting them cannot double-count an attempt whose task
   * record write was lost.
   * @param rootTaskId - original dispatched task whose admissions are counted.
   * @returns the number of admitted resume attempts.
   */
  private admittedResumeCount(rootTaskId: string): number {
    let count = 0
    for (const [, receipt] of this.requireReceipts().entries()) {
      if (receipt.resumeAttempt !== null && receipt.resumeRootTaskId === rootTaskId) count += 1
    }
    return count
  }

  /**
   * Whether an admitted instruction is already recorded in the Session or still
   * queued in its live Inbox.
   *
   * The durable `user/message` source echoes the submitted request id, and a
   * queued instruction carries it in the live Agent inbox; either is proof the
   * submission happened. Where the Session put that instruction is read from
   * the same history by `bindAttemptTurn`, which the recovery entry point uses
   * so the resumed turn is identified by its own instruction rather than by the
   * last turn end at recovery time.
   * @param receipt - the receipt holding the admitted attempt.
   * @returns whether the instruction was observed.
   */
  private instructionSubmitted(receipt: ReceiptRecordState): boolean {
    const requestId = receipt.resumeRequestId
    if (requestId === null) return receipt.resumeSubmitted
    const session = this.resumeSession(receipt)
    return receipt.resumeSubmitted
      || (session !== undefined && this.recordedResumeInstruction(session, requestId) !== undefined)
      || this.inboxHoldsInstruction(receipt)
  }

  /** The Session one admitted receipt's instruction targets, when it is attached. */
  private resumeSession(receipt: ReceiptRecordState): Session | undefined {
    const task = this.requireTasks().get(receipt.taskId)
    return task === undefined ? undefined : this.ctx.sessions.get(task.sessionId)
  }

  /** Whether one submitted instruction is still queued in the Session's live Inbox. */
  private inboxHoldsInstruction(receipt: ReceiptRecordState): boolean {
    const requestId = receipt.resumeRequestId
    if (requestId === null) return false
    const session = this.resumeSession(receipt)
    if (session === undefined) return false
    const inbox = this.ctx.get('agents')?.get(session.id)?.inbox
    if (inbox === undefined) return false
    const matches = (message: { readonly source: { readonly kind: string; readonly rpcId?: string } }): boolean =>
      message.source.kind === 'user' && message.source.rpcId === requestId
    return inbox.nextTurn.some(matches) || inbox.nextStep.some(matches)
  }

  /**
   * The turn one stored resume instruction was recorded in.
   *
   * The instruction is a real user message carrying the attempt's deterministic
   * request id, so this is what ties the attempt to the turn that consumed it,
   * never to whichever turn ended last. An instruction recorded between turns —
   * a prompt surface that writes the message before the loop claims it — belongs
   * to the first turn that starts after it.
   * @param session - the Session the instruction was submitted to.
   * @param requestId - deterministic instruction identity.
   * @returns the claiming turn, or undefined when the instruction is not recorded.
   */
  private recordedResumeInstruction(session: Session, requestId: string): { seq: number; turn: number | null } | undefined {
    const state = this.ctx.sessionProjections.stateOf(session, 'taskFeedbackFacts')
    if (state === undefined) throw new Error('task-feedback session projection is not registered')
    return state.instructions[requestId]
  }

  /**
   * Persist the root task's resume count as a readable cache of the receipt
   * ledger, which already committed the admission.
   *
   * A failed write is reported and otherwise ignored: the derived count stays
   * authoritative, so the admission is not lost and cannot be spent again.
   * @param root - the original task record before this admission.
   * @param count - the admitted-resume count after the receipt landed.
   * @returns the root record callers should read now.
   */
  private async cacheResumeCount(root: TaskRecordState, count: number): Promise<TaskRecordState> {
    const next: TaskRecordState = { ...root, autoResumeCount: count, updatedAt: this.now() }
    this.live.set(next.taskId, next)
    try {
      await this.requireTasks().put(next.taskId, next)
    } catch (error) {
      this.ctx.logger.warn(
        `task-feedback: the resume-count cache for ${JSON.stringify(next.taskId)} did not land; `
        + `the receipt ledger remains authoritative: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return next
  }

  /** The attempt record one admitted receipt describes. */
  private attemptOf(receipt: ReceiptRecordState): TaskResumeAttempt {
    return {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- admission writes resumeTaskId with resumeAttempt and resumeRequestId.
      taskId: receipt.resumeTaskId!,
      attempt: (receipt.resumeAttempt ?? 0) + 1,
      // oxlint-disable-next-line typescript/no-non-null-assertion -- admission writes resumeRequestId with resumeAttempt and resumeTaskId.
      requestId: receipt.resumeRequestId!,
    }
  }

  /**
   * Register the follow-up task and submit the instruction once.
   *
   * The instruction carries a deterministic request id, so an attempt whose
   * submission was already observed skips the prompt. The admission persisted
   * the cursor and turn-end baseline it was observed from, so a registration
   * delayed past the resumed turn binds that turn through the instruction's own
   * recorded message and settles the task from the Session's recorded facts: a
   * completed, failed, paused, or still-open resumed turn is reported instead of
   * being read as pre-registration history. A failed submission still leaves no
   * task that would bind a later manual turn as the automatic resume.
   */
  private async finishResumeAttempt(
    root: TaskRecordState,
    source: TaskRecordState,
    receipt: ReceiptRecordState,
  ): Promise<TaskResumeAttempt> {
    const attempt = this.attemptOf(receipt)
    const session = this.ctx.sessions.get(source.sessionId)
    const observation = {
      fromSeq: receipt.resumeFromSeq ?? (session === undefined ? 0 : Number(session.seq)),
      lastEndTurnAtRegistration: receipt.resumeLastEndTurnAtRegistration ?? this.lastEndTurnOf(session),
    }
    const submitted = this.instructionSubmitted(receipt)
    if (!submitted) {
      const controller = this.ctx.get('sessionController')
      if (controller === undefined) {
        throw new RemoteError(
          'task-feedback/resume-unavailable',
          'automatic resume needs the Session controller, which this deployment does not mount',
          { taskId: source.taskId },
        )
      }
      if (session === undefined) {
        throw new RemoteError(
          'task-feedback/resume-unavailable',
          `the bound Session ${JSON.stringify(source.sessionId)} is not attached to this Host`,
          { taskId: source.taskId },
        )
      }
      try {
        await controller.prompt({
          // oxlint-disable-next-line typescript/no-non-null-assertion -- the admission that admitted this attempt wrote the instruction id.
          requestId: brandString<SessionRequestId>(receipt.resumeRequestId!),
          sessionId: source.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: AUTO_RESUME_PROMPT }],
        }, this.stopping.signal)
      } catch (error) {
        throw new RemoteError(
          'task-feedback/resume-submit-failed',
          `submitting the resume instruction failed: ${error instanceof Error ? error.message : String(error)}`,
          // oxlint-disable-next-line typescript/no-non-null-assertion -- same admitted receipt the prompt above used.
          { taskId: source.taskId, requestId: receipt.resumeRequestId! },
        )
      }
    }
    await this.ensureAttemptTask(root, source, receipt, observation)
    if (!receipt.resumeSubmitted) {
      const latest = this.requireReceipts().get(receipt.deliveryId) ?? receipt
      const submittedReceipt: ReceiptRecordState = { ...latest, resumeSubmitted: true, updatedAt: this.now() }
      await this.requireReceipts().put(submittedReceipt.deliveryId, submittedReceipt)
    }
    return attempt
  }

  /**
   * Register the follow-up task once, bound to the turn that consumed its
   * instruction.
   *
   * Both the initial write after admission and a replay that finds the task
   * already present route through the same catch-up decision, so a record whose
   * instruction the Session already recorded but whose turn binding never
   * landed is rebound from that history and reported in the state it justifies.
   * The write happens inside the caller's serialized update, so it composes with
   * the admission instead of racing it.
   * @param root - original task whose budget and identity the attempt shares.
   * @param source - the failed task the attempt resumes.
   * @param receipt - the admitted receipt naming the attempt task.
   * @param observation - admission cursor and turn-end baseline persisted with the admission.
   */
  private async ensureAttemptTask(
    root: TaskRecordState,
    source: TaskRecordState,
    receipt: ReceiptRecordState,
    observation: { fromSeq: number; lastEndTurnAtRegistration: number | null },
  ): Promise<void> {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- called only for a receipt admission already wrote.
    const attemptTaskId = receipt.resumeTaskId!
    const session = this.ctx.sessions.get(source.sessionId)
    const existing = this.requireTasks().get(attemptTaskId)
    if (existing !== undefined) {
      // The task was registered without its turn binding, then the instruction
      // was consumed. Rebind from the instruction's own history and report
      // whatever that turn already did.
      const settled = session === undefined ? undefined : this.decideAttemptCatchUp(existing, session)
      if (settled === undefined) return
      this.live.set(settled.taskId, settled)
      await this.requireTasks().put(settled.taskId, settled)
      await this.enqueue(settled)
      return
    }
    const now = this.now()
    const accepted: TaskRecordState = {
      taskId: attemptTaskId,
      sessionId: source.sessionId,
      turn: null,
      target: source.target,
      acceptance: source.acceptance,
      fromSeq: observation.fromSeq,
      state: session === undefined ? 'disconnected' : 'accepted',
      summary: `automatic resume attempt ${String(receipt.resumeAttempt ?? 0)} for ${JSON.stringify(rootTaskIdOf(root))}; waiting for the resumed turn`,
      evidence: { sessionId: source.sessionId, turn: null, seq: null, eventSeqs: [] },
      waitKey: null,
      needsInput: null,
      lastEndTurnAtRegistration: observation.lastEndTurnAtRegistration,
      parentTaskId: source.taskId,
      rootTaskId: rootTaskIdOf(root),
      attempt: (receipt.resumeAttempt ?? 0) + 1,
      autoResumeCount: this.admittedResumeCount(rootTaskIdOf(root)),
      autoResumeLimit: root.autoResumeLimit,
      resumeEligible: false,
      leakedToolSyntax: null,
      resumeRequestId: receipt.resumeRequestId,
      resumeInstructionSeq: null,
      createdAt: now,
      updatedAt: now,
    }
    const record = (session === undefined ? undefined : this.decideAttemptCatchUp(accepted, session)) ?? accepted
    await this.requireTasks().put(record.taskId, record)
    this.live.set(record.taskId, record)
    await this.enqueue(record)
  }

  /**
   * The record that folds the facts one Session already recorded into an
   * attempt task, or undefined when those facts leave it unchanged.
   *
   * The attempt's own instruction is the only thing that identifies its turn,
   * so an attempt whose binding never landed is first rebound from the
   * Session's recorded history by request id; whichever turn happened to end
   * last, or a manual turn, is never substituted. The recorded turn's outcome
   * is then read from the projections the live watcher maintains, so a turn
   * that ended, failed, paused for an approval, or is still open is reported
   * exactly as the live feed would have reported it. A structured-question
   * pause has no Session event and is therefore only observable live; a turn
   * the projections can no longer place leaves the record unchanged.
   * @param record - the attempt task as just written or read.
   * @param session - the Session the attempt runs on.
   * @returns the record to publish, or undefined when nothing is decided yet.
   */
  private decideAttemptCatchUp(record: TaskRecordState, session: Session): TaskRecordState | undefined {
    const bound = this.bindAttemptTurn(record, session)
    if (bound === undefined) return undefined
    // A record rebound from history has to land even when its state was
    // already right, or the binding is lost again on the next restart.
    const rebound = bound === record ? undefined : bound
    if (bound.turn === null) return rebound
    const wait: SessionWaitState | undefined = this.ctx.sessionProjections.stateOf(session, 'sessionWait')
    const closed = wait?.closedTurns[String(bound.turn)]
    if (closed !== undefined) {
      return this.settleRecord(bound, session, bound.turn, closed, rebound)
    }
    if (this.openTurnOf(session) !== bound.turn) return rebound
    const pending = Object.entries(wait?.pendingApprovals ?? {})
    const ask = pending[pending.length - 1]
    if (ask !== undefined) {
      return this.decideTransition(bound, 'waiting_approval', `waiting for an approval on ${ask[1]}`, undefined, ask[0]) ?? rebound
    }
    return this.decideTransition(bound, 'running', `turn ${String(bound.turn)} is already open`, undefined) ?? rebound
  }

  /**
   * Bind an attempt task to the instruction the Session recorded for it, and to
   * the turn that consumed that instruction when one has.
   *
   * The instruction carries the attempt's deterministic request id, so the
   * Session's recorded history names the exact turn it was consumed in no
   * matter when the binding write is attempted. An instruction recorded before
   * any turn has claimed it still records its log position, which is what lets
   * the live watcher settle the first turn that ends after it. A record that
   * already names a turn is returned as is; a Session that has not recorded the
   * instruction leaves the record unbound.
   * @param record - the attempt task as just written or read.
   * @param session - the Session the attempt runs on.
   * @returns the record carrying what the Session recorded, or undefined when it cannot bind.
   */
  private bindAttemptTurn(record: TaskRecordState, session: Session): TaskRecordState | undefined {
    if (record.turn !== null) return record
    if (record.resumeRequestId === null) return undefined
    const recorded = this.recordedResumeInstruction(session, record.resumeRequestId)
    if (recorded === undefined) return undefined
    const resumeInstructionSeq = record.resumeInstructionSeq ?? recorded.seq
    if (recorded.turn === null && resumeInstructionSeq === record.resumeInstructionSeq) return undefined
    return { ...record, turn: recorded.turn, resumeInstructionSeq, updatedAt: this.now() }
  }

  /**
   * Why a failure may not be resumed, or null when it may.
   *
   * The check reads durable facts: the delivery must be this task's `failed`
   * outcome for the exact reasoning_text condition, the Session's last recorded
   * turn end must still be that failure, no newer turn may be open or queued,
   * and the task must still carry the same target.
   */
  private refuseResume(
    task: TaskRecordState,
    delivery: DeliveryRecordState,
  ): { decision: TaskResumeDecision; reason: string } | null {
    if (delivery.payload.state !== 'failed' || task.state !== 'failed') {
      return { decision: 'not-applicable', reason: 'the delivery is not a recorded task failure' }
    }
    if (!task.resumeEligible || !delivery.payload.resumeEligible) {
      return { decision: 'not-applicable', reason: 'the recorded failure is not the reasoning_text protocol condition' }
    }
    if (delivery.target.threadId !== task.target.threadId) {
      return { decision: 'superseded', reason: 'the notification target no longer matches the task target' }
    }
    const session = this.ctx.sessions.get(task.sessionId)
    if (session === undefined) {
      return { decision: 'superseded', reason: 'the bound Session is not attached to this Host' }
    }
    if (this.openTurnOf(session) !== null) {
      return { decision: 'running', reason: 'the Session already has an open turn' }
    }
    if (this.hasPendingInput(task.sessionId)) {
      return { decision: 'superseded', reason: 'a newer user message is already queued for the Session' }
    }
    const wait: SessionWaitState | undefined = this.ctx.sessionProjections.stateOf(session, 'sessionWait')
    const lastEnd = wait?.lastEndReason ?? null
    if (!isReasoningTextProtocolFailure(lastEnd)) {
      return { decision: 'superseded', reason: 'the Session no longer records this failure as its last turn end' }
    }
    if (delivery.payload.turn !== null && wait?.lastEndTurn !== delivery.payload.turn) {
      return { decision: 'superseded', reason: 'a newer turn already ended on the Session' }
    }
    return null
  }

  /** Whether the Session's live agent already holds queued input. */
  private hasPendingInput(sessionId: TaskRecordState['sessionId']): boolean {
    const agent = this.ctx.get('agents')?.get(sessionId)
    if (agent === undefined) return false
    return agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0
  }

  /** One resume decision with its durable records. */
  private resumeDecision(
    decision: TaskResumeDecision,
    reason: string,
    claimed: TaskReceiveValue,
    attempt: TaskResumeAttempt | null,
  ): TaskResumeValue {
    return { decision, reason, receipt: claimed.receipt, delivery: claimed.delivery, attempt }
  }

  /** Apply an acknowledgement inside the durable-update queue. */
  private async acknowledge(request: TaskAckRequest): Promise<TaskAckValue> {
    const outbox = this.requireOutbox()
    const stored = outbox.get(request.deliveryId)
    if (stored === undefined || stored.taskId !== request.taskId) {
      throw new RemoteError(
        'task-feedback/delivery-not-found',
        `no delivery ${JSON.stringify(request.deliveryId)} for task ${JSON.stringify(request.taskId)}`,
        { taskId: request.taskId, deliveryId: request.deliveryId },
      )
    }
    // A retired delivery was never handed to the receiver, so an acknowledgment
    // cannot revive it; the record is returned unchanged and stays monotonic.
    if (stored.retired) return { delivery: stored }
    if (STAGE_ORDER.indexOf(request.stage) <= STAGE_ORDER.indexOf(stored.stage)) return { delivery: stored }
    const next: DeliveryRecordState = {
      ...stored,
      stage: request.stage,
      acknowledged: true,
      nextAttemptAt: null,
      updatedAt: this.now(),
    }
    await outbox.put(request.deliveryId, next)
    return { delivery: next }
  }

  /**
   * Settle the watcher's writes, then attempt every due delivery once.
   *
   * A refused attempt is retried with a capped exponential delay until the
   * attempt budget is spent; an exhausted delivery stays pending and
   * unacknowledged, so nothing is dropped silently.
   * @returns how many were attempted, delivered, still pending, and exhausted.
   */
  @Remote('flush')
  async flush(): Promise<TaskFlushValue> {
    await this.settled()
    const { value, nextDueAt } = await this.serializePass(() => this.deliverDue())
    if (nextDueAt !== null) this.scheduleDelivery(Math.max(0, nextDueAt - Date.now()))
    return value
  }

  /**
   * Wait until no delivery pass is in flight.
   *
   * The scheduled pump runs from a timer, so a caller that must observe a
   * quiescent outbox — a test, or an orderly shutdown step — needs a point to
   * await rather than a delay to guess.
   * @returns nothing once the last started pass has settled.
   */
  async idle(): Promise<void> {
    while (true) {
      const current = this.passes
      await Promise.allSettled([current])
      if (current === this.passes) return
    }
  }

  /** Chain one pass onto the single delivery chain. */
  private serializePass<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.passes.then(operation, operation)
    this.passes = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Arm the single delivery wake-up.
   *
   * At most one timer exists: a nearer deadline replaces a later one, and a
   * later one never pushes an armed nearer one out. The timer is unref'd, so a
   * pending retry never keeps the process alive. Storage events arm this; no
   * Session listener ever waits on it.
   * @param delayMs - milliseconds until the next pass.
   */
  private scheduleDelivery(delayMs: number): void {
    if (this.closed || !this.config.autoDeliver) return
    const dueAt = Date.now() + delayMs
    if (this.timer !== undefined) {
      if (this.timerDueMs !== undefined && this.timerDueMs <= dueAt) return
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.timerDueMs = dueAt
    const timer = setTimeout(() => {
      this.timer = undefined
      this.timerDueMs = undefined
      void this.tick().catch((error: unknown) => {
        this.ctx.logger.warn('task-feedback: delivery stopped', error)
      })
    }, delayMs)
    timer.unref()
    this.timer = timer
  }

  /** One scheduled pass, followed by the wake-up its result asks for. */
  private async tick(): Promise<void> {
    if (this.closed) return
    await this.settled()
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can set `closed` while the pass is awaited.
    if (this.closed) return
    const { nextDueAt } = await this.serializePass(() => this.deliverDue())
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can set `closed` while the pass is awaited.
    if (this.closed || nextDueAt === null) return
    this.scheduleDelivery(Math.max(0, nextDueAt - Date.now()))
  }

  /** Cancel the wake-up and wait for the pass already running. */
  private async stopDelivery(): Promise<void> {
    this.closed = true
    this.stopping.abort()
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.timerDueMs = undefined
    }
    await this.idle()
    await Promise.allSettled([...this.writing])
    await this.commits
  }

  /**
   * Attempt every due delivery once and report the next deadline.
   *
   * Runs only inside the serialized chain. A refused attempt is retried with a
   * capped exponential delay until the attempt budget is spent; an exhausted
   * delivery stays pending and unacknowledged, so nothing is dropped silently,
   * and a refused attempt never touches the task record.
   * @returns the pass counts plus the earliest pending retry deadline.
   */
  private async deliverDue(): Promise<{ value: TaskFlushValue; nextDueAt: number | null }> {
    const outbox = this.requireOutbox()
    const now = Date.now()
    let attempted = 0
    let delivered = 0
    let exhausted = 0
    for (const [deliveryId, stored] of [...outbox.entries()]) {
      if (this.closed) break
      if (stored.acknowledged || stored.retired) continue
      // A successful transport handoff is terminal for the sender. The Codex
      // queue owns the message from here; retrying before its receiver claims
      // it appends duplicate wake-ups rather than recovering a failed send.
      if (stored.stage === 'delivered') continue
      if (stored.attempts >= this.config.maxDeliveryAttempts) { exhausted += 1; continue }
      if (stored.nextAttemptAt !== null && Date.parse(stored.nextAttemptAt) > now) continue
      attempted += 1
      const result = await this.sendBounded(stored)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can set `closed` while the send is awaited.
      if (this.closed) break
      const attempts = stored.attempts + 1
      if (result.accepted) delivered += 1
      await this.commit(async () => {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the entry was read above and only the attempt below rewrites it.
        const latest = outbox.get(deliveryId)!
        await outbox.put(deliveryId, {
          ...latest,
          stage: latest.acknowledged ? latest.stage : result.accepted ? 'delivered' : latest.stage,
          attempts,
          nextAttemptAt: latest.acknowledged || result.accepted || attempts >= this.config.maxDeliveryAttempts
            ? null
            : new Date(Date.now() + this.retryDelayMs(attempts)).toISOString(),
          updatedAt: this.now(),
        })
      })
      if (!result.accepted && attempts >= this.config.maxDeliveryAttempts) exhausted += 1
    }
    let pending = 0
    let nextDueAt: number | null = null
    for (const [, record] of outbox.entries()) {
      if (record.acknowledged || record.retired) continue
      pending += 1
      if (record.stage === 'delivered') continue
      if (record.attempts >= this.config.maxDeliveryAttempts) continue
      const due = record.nextAttemptAt === null ? now : Date.parse(record.nextAttemptAt)
      if (nextDueAt === null || due < nextDueAt) nextDueAt = due
    }
    return { value: { attempted, delivered, pending, exhausted }, nextDueAt }
  }

  /** Bound transport errors and hung sends without changing task outcomes. */
  private async sendBounded(stored: DeliveryRecordState): Promise<{ accepted: boolean }> {
    const controller = new AbortController()
    const stop = (): void => { controller.abort() }
    this.stopping.signal.addEventListener('abort', stop, { once: true })
    if (this.stopping.signal.aborted) stop()
    const timer = setTimeout(stop, this.config.sendTimeoutMs)
    let cancel = (): void => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = () => { reject(new Error('delivery timed out or stopped')) }
      controller.signal.addEventListener('abort', cancel, { once: true })
      if (controller.signal.aborted) cancel()
    })
    try {
      return await Promise.race([aborted, Promise.resolve().then(() => this.adapter.send({
        deliveryId: stored.deliveryId,
        threadId: stored.target.threadId,
        message: composeWakeMessage(stored.payload, stored.deliveryId, this.config.summaryMaxChars),
      }, controller.signal))])
    } catch (error) {
      if (!this.closed) this.ctx.logger.warn('task-feedback: transport failed', error)
      return { accepted: false }
    } finally {
      clearTimeout(timer)
      this.stopping.signal.removeEventListener('abort', stop)
      controller.signal.removeEventListener('abort', cancel)
    }
  }

  /** The capped exponential delay before one retry. */
  private retryDelayMs(attempts: number): number {
    return Math.min(this.config.retryBaseMs * 2 ** (attempts - 1), this.config.retryMaxMs)
  }

  /** Validate a registration before anything durable is written. */
  private requireRegistration(request: TaskRegistration): void {
    const bad = (message: string): never => {
      throw new RemoteError('gateway/bad-request', message, {})
    }
    if (request.taskId.trim() === '') bad('task-feedback: taskId must be non-empty')
    if (request.target.threadId.trim() === '') {
      bad('task-feedback: the target thread id must be supplied by the caller, never inferred from recent sessions')
    }
    if (request.acceptance.trim() === '') {
      bad('task-feedback: acceptance criteria are required so the review has a stated bar')
    }
    if (request.turn !== undefined && (!Number.isSafeInteger(request.turn) || request.turn < 0)) {
      bad('task-feedback: turn must be a non-negative integer')
    }
    if (request.fromSeq !== undefined && (!Number.isSafeInteger(request.fromSeq) || request.fromSeq < 0)) {
      bad('task-feedback: fromSeq must be a non-negative integer')
    }
  }

  /**
   * Fold one committed Session event into every open task bound to that Session.
   * @param session - the Session the event committed on.
   * @param event - one committed Session event.
   */
  private observe(session: Session, event: SessionEvent): void {
    if (this.closed) return
    if (event.type === 'turn/start') this.openTurns.set(session.id, event.data.turn)
    else if (event.type === 'turn/end') {
      this.openTurns.delete(session.id)
      // A manual stop keeps pending inbox work for the next turn, so an
      // automatic resume that is still queued has to stand down before the
      // operator's own continuation claims it.
      if (event.data.reason.kind === 'aborted' && event.data.reason.reason.kind === 'user') {
        this.standDownQueuedResume(session)
      }
    }
    for (const record of this.boundTasks(session.id, event.seq)) this.applyEvent(session, record, event)
  }

  /**
   * Withdraw a queued automatic resume when the operator stops the Session.
   *
   * The stop is `agent.cancel` with `keepInbox`, so an instruction that was
   * accepted but not yet claimed by a turn would otherwise start the operator's
   * next turn: the old delivery would append a continuation after a manual stop.
   * The instruction is removed from the live inbox and its attempt task is
   * reported `cancelled`, which is the explicit record of the stand-down. The
   * admission and the budget it spent are kept, so a replay re-validates against
   * the stopped Session and reports `superseded` instead of admitting a second
   * attempt.
   * @param session - the Session the operator stopped.
   */
  private standDownQueuedResume(session: Session): void {
    const inbox = this.ctx.get('agents')?.get(session.id)?.inbox
    if (inbox === undefined) return
    for (const [, receipt] of [...this.requireReceipts().entries()]) {
      if (receipt.resumeAttempt === null || receipt.resumeRequestId === null) continue
      const failed = this.live.get(receipt.taskId)
      if (failed === undefined || failed.sessionId !== session.id) continue
      const matches = (message: { readonly source: { readonly kind: string; readonly rpcId?: string } }): boolean =>
        message.source.kind === 'user' && message.source.rpcId === receipt.resumeRequestId
      const pending = inbox.nextTurn.find(matches) ?? inbox.nextStep.find(matches)
      const recorded = this.recordedResumeInstruction(session, receipt.resumeRequestId)
      // A recorded instruction with a turn was already claimed by that turn, and
      // one with no pending item and no between-turn record is gone; neither is
      // this service's to withdraw.
      if (pending === undefined && (recorded === undefined || recorded.turn !== null)) continue
      if (pending !== undefined) inbox.remove(pending.id)
      this.track(this.commit(async () => {
        const latest = this.requireReceipts().get(receipt.deliveryId) ?? receipt
        await this.requireReceipts().put(latest.deliveryId, { ...latest, resumeSubmitted: false, updatedAt: this.now() })
      }))
      const attemptId = receipt.resumeTaskId
      const attempt = attemptId === null ? undefined : this.live.get(attemptId)
      if (attempt === undefined) continue
      this.transition(
        attempt,
        'cancelled',
        'the operator stopped the Session; the queued automatic resume instruction was withdrawn',
        undefined,
      )
    }
  }

  /**
   * Fold one committed event into one task record.
   *
   * This is the single event-to-state rule set: live observation and the
   * recovery replay of an attempt that was registered late both run it, so a
   * turn that already ran settles the task exactly as the live feed would.
   * @param session - the Session the event committed on.
   * @param record - the task as last read.
   * @param event - one committed Session event.
   */
  private applyEvent(session: Session, record: TaskRecordState, event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start': {
        if (!this.matchesTurn(record, event.data.turn, event.seq)) return
        const turn = record.turn ?? event.data.turn
        this.transition({ ...record, turn }, 'running', `turn ${String(turn)} started`, event)
        return
      }
      case 'turn/end':
        if (!this.matchesTurn(record, event.data.turn, event.seq)) return
        this.settleTurn(record, session, event.data.turn, event.data.reason, event)
        return
      case 'approval/asked':
        if (this.awaitingResumeInstruction(record)) return
        if (record.turn !== null && this.openTurnOf(session) !== record.turn) return
        // The deciding event's position is the approval's stable identity.
        this.transition(
          { ...record, needsInput: this.approvalNotice(session, event) },
          'waiting_approval',
          `waiting for an approval on ${event.data.toolName}`,
          event,
          String(event.seq),
        )
        return
      case 'approval/decided':
        if (this.awaitingResumeInstruction(record)) return
        if (record.turn !== null && this.openTurnOf(session) !== record.turn) return
        this.transition(record, 'running', this.summaryOfApproval(event.data.outcome), event)
        return
      case 'user/message': {
        // The instruction that claimed this turn is the only fact that binds an
        // attempt to it, so a manual turn can never be read as the resumed one.
        if (record.turn !== null || record.resumeRequestId === null) return
        if (!isResumeInstruction(event, record.resumeRequestId)) return
        const claimed = this.openTurns.get(session.id)
        if (claimed === undefined) return
        const boundTurn: TaskRecordState = { ...record, turn: claimed, resumeInstructionSeq: Number(event.seq) }
        this.transition(boundTurn, 'running', `turn ${String(claimed)} claimed the automatic resume instruction`, event)
        return
      }
      default:
        return
    }
  }

  /**
   * Record a Session asking its human a structured question.
   *
   * The request carries no Session event, so the pause is identified by the
   * cursor it was observed at plus the caller-provided question ids: one
   * request replayed at one cursor is one pause, while two different requests at
   * the same cursor are two. The notice it publishes carries the bounded
   * question text and options plus the Session the answer belongs to, which is
   * what lets a dispatcher relay the question instead of guessing an answer.
   * @param session - the Session whose agent asked, when it is attached.
   * @param questions - the request's questions, in caller order.
   */
  private observeQuestion(session: Session | undefined, questions: readonly AskUserQuestionItem[]): void {
    if (this.closed || session === undefined) return
    const seq = Number(session.seq)
    const waitKey = questionObservationKey(seq, questions)
    const needsInput = this.questionNotice(session, seq, waitKey, questions)
    for (const record of this.boundTasks(session.id, seq)) {
      if (this.awaitingResumeInstruction(record)) continue
      if (record.turn !== null && this.openTurnOf(session) !== record.turn) continue
      this.transition({ ...record, evidence: { ...record.evidence, seq }, needsInput },
        'waiting_input', 'the Session asked its human a question', undefined, waitKey)
    }
  }

  /**
   * The bounded notice of one structured-question pause.
   *
   * The caller's supporting `detail` stays in the Session: this notice names
   * the questions, their options, and where the answer belongs, and a
   * dispatcher that needs the full text reads it there.
   * @param session - the Session whose agent asked.
   * @param seq - Session-log cursor the request was observed at.
   * @param pauseId - stable identity of the pause.
   * @param questions - the request's questions, in caller order.
   * @returns the bounded pause notice.
   */
  private questionNotice(
    session: Session,
    seq: number,
    pauseId: string,
    questions: readonly AskUserQuestionItem[],
  ): NeedsInputNoticeState {
    return {
      kind: 'question',
      sessionId: session.id,
      turn: this.openTurnOf(session),
      seq,
      pauseId,
      questions: boundedQuestions(
        questions,
        this.config.needsInputMaxQuestions,
        this.config.needsInputMaxOptions,
        this.config.needsInputMaxChars,
      ),
      approval: null,
    }
  }

  /**
   * The bounded notice of one approval pause.
   * @param session - the Session waiting for the decision.
   * @param event - the recorded `approval/asked` event.
   * @returns the bounded pause notice.
   */
  private approvalNotice(session: Session, event: SessionEvent<'approval/asked'>): NeedsInputNoticeState {
    return {
      kind: 'approval',
      sessionId: session.id,
      turn: this.openTurnOf(session),
      seq: Number(event.seq),
      pauseId: String(event.seq),
      questions: [],
      approval: {
        approvalId: String(event.data.id),
        toolName: boundedLine(event.data.toolName, this.config.needsInputMaxChars),
      },
    }
  }

  /** Every open task bound to one Session whose cursor the event has passed. */
  private boundTasks(sessionId: TaskRecordState['sessionId'], seq: number): TaskRecordState[] {
    return [...this.live.values()]
      .filter(record => record.sessionId === sessionId && OPEN_STATES.includes(record.state) && seq >= record.fromSeq)
  }

  /** Whether a `turn/end` settles this task. */
  private matchesTurn(record: TaskRecordState, turn: number, seq: number): boolean {
    if (record.turn !== null) return record.turn === turn
    if (record.resumeRequestId === null) return seq >= record.fromSeq
    // An automatic-resume attempt settles only on the turn that consumed its
    // own instruction. Before that instruction is recorded, no turn may settle
    // it; afterwards the first turn to end is necessarily the one that claimed
    // it, because turns run one at a time and the instruction precedes them.
    const instructionSeq = record.resumeInstructionSeq
    return instructionSeq !== null && seq >= instructionSeq
  }

  /**
   * Whether this task tracks an automatic resume whose instruction has not been
   * observed in the Session yet.
   * @param record - the task as last read.
   * @returns true while the attempt awaits its own instruction.
   */
  private awaitingResumeInstruction(record: TaskRecordState): boolean {
    return record.resumeRequestId !== null && record.resumeInstructionSeq === null
  }

  /** The one-line summary of a decided approval. */
  private summaryOfApproval(outcome: ApprovalOutcome): string {
    return `the approval was ${outcome}`
  }

  /** The one-line summary of a recorded turn end. */
  private summaryOf(reason: TurnEndReason): string {
    switch (reason.kind) {
      case 'completed':
        return 'the turn completed'
      case 'aborted':
        return `the turn was cancelled (${reason.reason.kind})`
      case 'error':
        return `the turn failed: ${reason.error.message}`
      case 'blocked':
        return 'the turn ended before any step was entered'
      case 'max-tokens':
        return 'a step reached its output-token ceiling'
      case 'interrupted':
        return 'the turn was interrupted and closed after the fact'
      default:
        return `the turn ended for reason ${(reason as { kind: string }).kind}`
    }
  }

  /**
   * Move one task to a new state, durably, and enqueue its notification once.
   *
   * A terminal state is written once: a later event cannot rewrite a recorded
   * outcome, so a replay or a late event cannot turn a completed task into a
   * failed one.
   * @param record - the task as last read, with any turn this transition learns.
   * @param state - the state now observed.
   * @param summary - one line describing what was observed.
   * @param event - the event that decided the state, when one did.
   * @param waitKey - stable identity of this pause for a waiting state; absent otherwise.
   * @param resumeEligible - whether the observed failure matches the bounded automatic-resume condition.
   * @param leakedToolSyntax - tool-invocation markup found in a completed turn's visible text, when any.
   */
  private transition(
    record: TaskRecordState,
    state: TaskState,
    summary: string,
    event: SessionEvent | undefined,
    waitKey?: string,
    resumeEligible = false,
    leakedToolSyntax: readonly string[] | null = null,
  ): void {
    this.publish(this.decideTransition(record, state, summary, event, waitKey, resumeEligible, leakedToolSyntax))
  }

  /**
   * Settle one task from a turn end the Session recorded.
   *
   * Live observation and the recovery replays both route through here, so a
   * completed turn that already ran is reported exactly as the live feed would
   * report it.
   * @param record - the task as last read.
   * @param session - the Session the turn ran on.
   * @param turn - the turn the end belongs to.
   * @param reason - the recorded turn end.
   * @param event - the deciding event, absent when a recovery reads recorded history.
   */
  private settleTurn(
    record: TaskRecordState,
    session: Session,
    turn: number,
    reason: TurnEndReason,
    event: SessionEvent | undefined,
  ): void {
    const settlement = this.settlementOf(session, turn, reason)
    this.transition(
      record,
      settlement.state,
      settlement.summary,
      event,
      undefined,
      settlement.resumeEligible,
      settlement.leakedToolSyntax,
    )
  }

  /**
   * The record one recorded turn end settles a task into, or the caller's
   * fallback when the observation changes nothing.
   * @param record - the task as last read.
   * @param session - the Session the turn ran on.
   * @param turn - the turn the end belongs to.
   * @param reason - the recorded turn end.
   * @param fallback - the record to return when the end decides no change.
   * @returns the record to publish, or the fallback.
   */
  private settleRecord(
    record: TaskRecordState,
    session: Session,
    turn: number,
    reason: TurnEndReason,
    fallback: TaskRecordState | undefined,
  ): TaskRecordState | undefined {
    const settlement = this.settlementOf(session, turn, reason)
    return this.decideTransition(
      record,
      settlement.state,
      settlement.summary,
      undefined,
      undefined,
      settlement.resumeEligible,
      settlement.leakedToolSyntax,
    ) ?? fallback
  }

  /**
   * What one recorded turn end settles: its state, its summary, and the facts a
   * delivery carries.
   *
   * A completed turn whose final visible text carries tool-invocation markup is
   * still `completed` as the loop recorded it, and its summary says the outcome
   * is unverified, so a notification never reads it as a business success. Such
   * a turn is not resume-eligible: only the exact reasoning_text failure is.
   * @param session - the Session the turn ran on.
   * @param turn - the turn the end belongs to.
   * @param reason - the recorded turn end.
   * @returns the settlement of that turn end.
   */
  private settlementOf(session: Session, turn: number, reason: TurnEndReason): TurnSettlement {
    const state = settledState(reason)
    const leaked = state === 'completed' ? this.completedTurnLeakage(session, turn) : []
    return {
      state,
      summary: leaked.length === 0 ? this.summaryOf(reason) : unverifiedCompletionSummary(leaked),
      resumeEligible: isReasoningTextProtocolFailure(reason),
      leakedToolSyntax: leaked.length === 0 ? null : leaked,
    }
  }

  /**
   * Tool-invocation markup the settling turn left in its visible text.
   *
   * Only the turn's last assistant message is read, from the end of the log
   * backwards: the loop ends a turn `completed` when that message requested no
   * tool call, so markup there is syntax that should have been a call. Reasoning
   * blocks, tool results, and earlier steps are never read, so a turn that
   * quoted the syntax and then called its tools normally is not flagged.
   * @param session - the Session the turn ran on.
   * @param turn - the turn whose last assistant message is read.
   * @returns the marker families found, empty when the turn left none.
   */
  private completedTurnLeakage(session: Session, turn: number): string[] {
    const state = this.ctx.sessionProjections.stateOf(session, 'taskFeedbackFacts')
    if (state === undefined) throw new Error('task-feedback session projection is not registered')
    return [...(state.finalToolSyntax[String(turn)] ?? [])]
  }

  /**
   * Publish one decided transition: the live view first, then the durable write
   * and its notification, on the serialized update chain.
   * @param next - the decided record, or undefined when nothing changed.
   */
  private publish(next: TaskRecordState | undefined): void {
    if (next === undefined) return
    // The live view moves first so several events of one tick cannot each read
    // the state before the last write landed.
    this.live.set(next.taskId, next)
    this.track(this.commit(async () => {
      await this.requireTasks().put(next.taskId, next)
      await this.enqueue(next)
    }))
  }

  /**
   * The record one transition would write, or undefined when it changes nothing.
   *
   * This is the single decision rule for a state change, so a transition a
   * caller folds into its own serialized write and one published by the live
   * watcher cannot disagree.
   * @param record - the task as last read, with any turn this transition learns.
   * @param state - the state now observed.
   * @param summary - one line describing what was observed.
   * @param event - the event that decided the state, when one did.
   * @param waitKey - stable identity of this pause for a waiting state; absent otherwise.
   * @param resumeEligible - whether the observed failure matches the bounded automatic-resume condition.
   * @param leakedToolSyntax - tool-invocation markup found in a completed turn's visible text, when any.
   * @returns the record to publish, or undefined when the observation changes nothing.
   */
  private decideTransition(
    record: TaskRecordState,
    state: TaskState,
    summary: string,
    event: SessionEvent | undefined,
    waitKey?: string,
    resumeEligible = false,
    leakedToolSyntax: readonly string[] | null = null,
  ): TaskRecordState | undefined {
    if (!OPEN_STATES.includes(record.state)) return undefined
    if (event !== undefined && record.evidence.eventSeqs.includes(Number(event.seq))) return undefined
    const nextWaitKey = waitKey ?? null
    // A pause's notice belongs to that pause alone: the caller that observes a
    // waiting state puts it on the record, and every transition out of a
    // waiting state drops it, so no later outcome carries a stale question.
    const nextNeedsInput = state === 'waiting_input' || state === 'waiting_approval'
      ? record.needsInput ?? null
      : null
    const eligible = state === 'failed' && resumeEligible
    const leaked = state === 'completed' && leakedToolSyntax !== null && leakedToolSyntax.length > 0
      ? [...leakedToolSyntax]
      : null
    // A replay of the same observation changes nothing. Waiting states pass no
    // event, so their identity is the deciding key rather than a log position.
    if (event === undefined && record.state === state && record.summary === summary
      && record.waitKey === nextWaitKey && record.resumeEligible === eligible
      && sameFamilies(record.leakedToolSyntax, leaked)) return undefined
    const evidence = {
      ...record.evidence,
      turn: record.turn,
      seq: event?.seq ?? record.evidence.seq,
      eventSeqs: event === undefined
        ? record.evidence.eventSeqs
        : [...record.evidence.eventSeqs, Number(event.seq)].slice(-EVIDENCE_EVENT_LIMIT),
    }
    return {
      ...record,
      state,
      summary,
      waitKey: nextWaitKey,
      needsInput: nextNeedsInput,
      resumeEligible: eligible,
      leakedToolSyntax: leaked,
      evidence,
      updatedAt: this.now(),
    }
  }

  /** Track one durable write the watcher started. */
  private track(operation: Promise<unknown>): void {
    this.writing.add(operation)
    void operation.then(
      () => { this.writing.delete(operation) },
      (error: unknown) => {
        this.writing.delete(operation)
        this.writeFailure = error
        // Reported, never swallowed: a failed write must not read as a state
        // the task reached, and a caller awaiting `settled()` has to be able to
        // see that something did not land.
        this.ctx.logger.warn(`task-feedback: durable write failed: ${error instanceof Error ? error.message : String(error)}`)
      },
    )
  }

  /** Enqueue one delivery per (task, state), once, when the state notifies. */
  private async enqueue(record: TaskRecordState): Promise<void> {
    if (!this.config.notifyStates.includes(record.state)) return
    const outbox = this.requireOutbox()
    const deliveryId = this.deliveryIdOf(record)
    if (outbox.get(deliveryId) !== undefined) return
    const payload: DeliveryRecordState['payload'] = {
      taskId: record.taskId,
      state: record.state,
      sessionId: record.sessionId,
      turn: record.turn,
      summary: record.summary,
      evidence: { ...record.evidence, eventSeqs: [...record.evidence.eventSeqs] },
      acceptance: record.acceptance,
      resumeEligible: record.state === 'failed' && record.resumeEligible,
      leakedToolSyntax: record.leakedToolSyntax === null ? null : [...record.leakedToolSyntax],
      needsInput: record.needsInput === null ? null : {
        ...record.needsInput,
        questions: record.needsInput.questions.map(question => ({
          ...question,
          options: question.options.map(option => ({ ...option })),
        })),
        approval: record.needsInput.approval === null ? null : { ...record.needsInput.approval },
      },
    }
    const now = this.now()
    await outbox.put(deliveryId, {
      deliveryId,
      taskId: record.taskId,
      target: record.target,
      stage: 'enqueued',
      attempts: 0,
      nextAttemptAt: null,
      acknowledged: false,
      retired: false,
      payload,
      createdAt: now,
      updatedAt: now,
    })
    const counters = this.requireCounters()
    await counters.set({ deliveryCount: counters.get().deliveryCount + 1 })
    // Armed only after the record is durable: a pass waits for the watcher's
    // writes, so the wake-up cannot read an outbox that does not contain this
    // delivery yet.
    this.scheduleDelivery(0)
  }

  /**
   * The durable id of the notification one task state owes.
   *
   * A waiting state carries its pause identity so two distinct pauses stay two
   * deliveries while a replay stays one. Records an older build wrote have no
   * wait key; their deciding event position is the compatible fallback.
   * @param record - the task state being notified.
   * @returns the delivery id.
   */
  private deliveryIdOf(record: TaskRecordState): string {
    if (record.state !== 'waiting_approval' && record.state !== 'waiting_input') return `${record.taskId}@${record.state}`
    const waitKey = record.waitKey ?? (record.evidence.seq === null ? null : String(record.evidence.seq))
    return `${record.taskId}@${record.state}${waitKey === null ? '' : `@${waitKey}`}`
  }

  /**
   * Rebuild open tasks from durable state after a restart.
   *
   * A task whose Session is attached but whose turn already ended while this
   * Host was down settles from the recorded end, so a completion is not lost.
   * A task whose Session is not attached becomes `disconnected` and keeps its
   * place: this Host neither cancels nor re-dispatches it, and the notification
   * says which of those happened. The repair pass afterwards re-enqueues a
   * notifying state whose delivery never landed, which is the crash between the
   * task write and the outbox write.
   */
  private async recover(): Promise<void> {
    for (const record of [...this.live.values()]) {
      if (!OPEN_STATES.includes(record.state)) continue
      const session = this.ctx.sessions.get(record.sessionId)
      if (session === undefined) {
        this.transition(record, 'disconnected', 'the bound Session is not attached to this Host; the task keeps its place', undefined)
        continue
      }
      // An automatic-resume attempt settles only on the turn its own
      // instruction was recorded in, so it is never settled by the last turn
      // that ended while this Host was down.
      if (this.settleRecordedCatchUp(record, session)) continue
      if (record.state === 'queued' || record.state === 'disconnected') {
        this.transition(record, 'accepted', 'recovered; waiting for the task turn', undefined)
      }
    }
    await this.settled()
    // Repair the split write: a task that reached a notifying state but whose
    // outbox insert did not land gets its delivery now. `enqueue` is a no-op
    // when the delivery already exists, so an acknowledged one is never re-sent.
    for (const record of [...this.live.values()]) await this.enqueue(record)
    await this.settled()
  }

  /**
   * Compensate tasks bound to a Session attached after this Host started.
   *
   * A seeded or restored Session loads its history without a per-event feed, so
   * this attach edge is the only point where a turn that already ended becomes
   * visible. Only open tasks bound to this exact Session are reconciled, and
   * each keeps its own turn and cursor match.
   * @param session - the Session just announced.
   */
  private reconcileAttached(session: Session): void {
    if (this.closed) return
    for (const record of [...this.live.values()]) {
      if (record.sessionId !== session.id || !OPEN_STATES.includes(record.state)) continue
      // An attempt waits for the turn that consumed its own instruction, so the
      // history loaded with this Session is folded in through that binding.
      if (this.settleRecordedCatchUp(record, session)) continue
      if (record.state === 'queued' || record.state === 'disconnected') {
        const running = record.turn !== null && this.openTurnOf(session) === record.turn
        this.transition(
          record,
          running ? 'running' : 'accepted',
          running ? `turn ${String(record.turn)} is already open` : 'recovered; waiting for the task turn',
          undefined,
        )
      }
    }
  }

  /**
   * Settle one open task from the Session state a restart or attach edge loaded.
   *
   * An automatic-resume attempt settles only on the turn its own instruction
   * was recorded in; every other open task settles when the Session recorded a
   * matching turn end. Recovery and the attach edge share this step so both
   * observe the same settlement.
   * @param record - the open task being reconciled.
   * @param session - the attached Session whose recorded end is folded in.
   * @returns whether the task settled, so the caller skips its own fallback.
   */
  private settleRecordedCatchUp(record: TaskRecordState, session: Session): boolean {
    if (record.resumeRequestId !== null) {
      this.publish(this.decideAttemptCatchUp(record, session))
      return true
    }
    const catchUp = this.recordedEnd(session, record)
    if (catchUp === undefined) return false
    this.settleTurn(record, session, catchUp.turn, catchUp.reason, undefined)
    return true
  }

  /** The turn open on one Session, from the loop's boundary fold. */
  private openTurnOf(session: Session): number | null {
    const projections = this.ctx.sessionProjections
    const state = projections.stateOf(session, 'turnBoundary')
    if (state === undefined || state.openTurnStartSeq === null) return null
    return state.lastTurn
  }

  /** The last turn end already on one Session, or null when none ended yet. */
  private lastEndTurnOf(session: Session | undefined): number | null {
    if (session === undefined) return null
    const projections = this.ctx.sessionProjections
    const state: SessionWaitState | undefined = projections.stateOf(session, 'sessionWait')
    return state?.lastEndTurn ?? null
  }

  /**
   * The turn end recorded while this Host was down, when the Session has one.
   *
   * A named turn matches by number, so an older turn can never settle it. An
   * unnamed turn matches only an end that came after registration, which is why
   * the baseline end is compared here. The turn number comes back with the
   * reason because a completed turn's visible text is read to tell a real
   * completion from one whose tool syntax never executed.
   * @param session - the Session whose recorded end is read.
   * @param record - the task whose turn and registration baseline decide the match.
   * @returns the turn and its recorded end, or undefined when no end matches.
   */
  private recordedEnd(session: Session, record: TaskRecordState): { turn: number; reason: TurnEndReason } | undefined {
    const projections = this.ctx.sessionProjections
    const state: SessionWaitState | undefined = projections.stateOf(session, 'sessionWait')
    if (state === undefined) return undefined
    if (record.turn !== null) {
      const reason = state.closedTurns[String(record.turn)]
      return reason === undefined ? undefined : { turn: record.turn, reason }
    }
    if (state.lastEndTurn === null || state.lastEndTurn === record.lastEndTurnAtRegistration) return undefined
    const reason = state.lastEndReason
    return reason === null ? undefined : { turn: state.lastEndTurn, reason }
  }

  /** The stored task a caller named, or a named failure. */
  private requireTask(taskId: string): TaskRecordState {
    const record = this.live.get(taskId)
    if (record === undefined) {
      throw new RemoteError('task-feedback/not-found', `no task ${JSON.stringify(taskId)} is registered`, { taskId })
    }
    return record
  }

  /** The stored task as callers see it. */
  private project(record: TaskRecordState): TaskRecord {
    return {
      taskId: record.taskId,
      sessionId: record.sessionId,
      turn: record.turn,
      target: record.target,
      acceptance: record.acceptance,
      fromSeq: record.fromSeq,
      state: record.state,
      summary: record.summary,
      evidence: { ...record.evidence, eventSeqs: [...record.evidence.eventSeqs] },
      parentTaskId: record.parentTaskId,
      rootTaskId: rootTaskIdOf(record),
      attempt: record.attempt,
      autoResumeCount: this.admittedResumeCount(rootTaskIdOf(record)),
      autoResumeLimit: record.autoResumeLimit,
      resumeEligible: record.state === 'failed' && record.resumeEligible,
      leakedToolSyntax: record.leakedToolSyntax === null ? null : [...record.leakedToolSyntax],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  /** One stored receipt as callers see it. */
  private projectReceipt(record: ReceiptRecordState): TaskReceipt {
    return {
      deliveryId: record.deliveryId,
      taskId: record.taskId,
      status: record.status,
      ownerId: record.ownerId,
      claimEpoch: record.claimEpoch,
      leaseExpiresAt: record.leaseExpiresAt,
      claimedAt: record.claimedAt,
      updatedAt: record.updatedAt,
    }
  }

  private now(): string {
    return new Date().toISOString()
  }

  private requireTasks(): KvTable<string, TaskRecordState> {
    if (this.taskTable === undefined) throw new Error('task-feedback: the task table is not open')
    return this.taskTable
  }

  private requireOutbox(): KvTable<string, DeliveryRecordState> {
    if (this.outboxTable === undefined) throw new Error('task-feedback: the outbox table is not open')
    return this.outboxTable
  }

  private requireReceipts(): KvTable<string, ReceiptRecordState> {
    if (this.receiptTable === undefined) throw new Error('task-feedback: the receipt table is not open')
    return this.receiptTable
  }

  private requireCounters(): DomainGlobal<{ deliveryCount: number }> {
    if (this.counters === undefined) throw new Error('task-feedback: the domain global record is not open')
    return this.counters
  }
}
