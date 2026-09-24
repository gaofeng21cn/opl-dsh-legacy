import type { Context } from '@deepseek-ai/cordis'
import type {
  ContextMessageNode, ConversationNodeDefinition, SteeringMessageNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isAppendSurfaceEvent, isReplacementSurfaceEvent, isRewindSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { InboxState } from './inbox.ts'
import { chatNode } from './common.ts'
import { contextForm, contextProducer } from './event-projection.ts'
import type { SupersededBranch } from './superseded-branch.ts'

interface ReferencedUserMessageNode extends UserMessageNode {
  /** Labels cited by the immediately following session-reference context. */
  readonly referenceLabels?: readonly string[]
  /** Skill names the same step's `skill-invocation` injections loaded. */
  readonly skillNames?: readonly string[]
  /** Branch this row replaced; present only on an edit-and-resend prompt replacement. */
  readonly replacedBranch?: SupersededBranch
}

interface ReferencedSteeringMessageNode extends SteeringMessageNode {
  /** Labels cited by the immediately following session-reference context. */
  readonly referenceLabels?: readonly string[]
  /** Skill names the same step's `skill-invocation` injections loaded. */
  readonly skillNames?: readonly string[]
  /** Branch this row replaced; present only on an edit-and-resend prompt replacement. */
  readonly replacedBranch?: SupersededBranch
}

type MessageNode = ReferencedUserMessageNode | ReferencedSteeringMessageNode | (ContextMessageNode & { readonly waking?: boolean })

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Ordinary turn-opening user message. */
    user: ReferencedUserMessageNode
    /** User message admitted into an active turn. */
    steering: ReferencedSteeringMessageNode
    /** Non-user context injected into model history. */
    context: ContextMessageNode
    /** Non-human input that starts a Turn. */
    'turn-trigger': ContextMessageNode
  }
}

function isCompactionCheckpoint(event: Parameters<ConversationNodeDefinition['match']>[0]): boolean {
  if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event)) return false
  const source = event.data.source as { kind?: unknown }
  return source.kind === 'compact-checkpoint'
}

/**
 * Whether this event is the message an edit-and-resend committed: a direct
 * human prompt that replaced the branch an earlier prompt opened. The Chat
 * transcript materializes the row and hides the superseded branch's rows from
 * the current generation; the replaced events stay in the append-only log.
 */
function isPromptRewrite(event: Parameters<ConversationNodeDefinition['match']>[0]): boolean {
  return event.type === 'user/message'
    && isReplacementSurfaceEvent(event)
    && event.data.source.kind === 'user'
}

/**
 * Read the branch range a replacement prompt declares.
 * @param event - Matched `user/message` event.
 * @returns Superseded branch for a replacement, otherwise undefined.
 */
function replacedBranch(
  event: Parameters<ConversationNodeDefinition['start']>[1]['event'],
): SupersededBranch | undefined {
  return event.type !== 'assistant/live-chunk' && isReplacementSurfaceEvent(event)
    ? { startSeq: event.surfaceOp.startSeq, untilSeq: event.seq }
    : undefined
}

/** User, steering, and injected-context message classification Definition. */
export const messageDefinition: ConversationNodeDefinition<MessageNode> = {
  kind: 'input-message',
  target: 'chat',
  match: (event) => {
    if (event.type === 'user/message') {
      return (isAppendSurfaceEvent(event) || isPromptRewrite(event)) && !isCompactionCheckpoint(event)
        ? { id: String(event.data.id), role: 'start' }
        : null
    }
    // Developer history is persisted for V4; presentation is intentionally deferred.
    if (event.type === 'developer/message' && !isRewindSurfaceEvent(event)) throw new Error('Chat developer messages are not supported yet')
    return null
  },
  start: (_context, match, reader) => {
    if (match.event.type !== 'user/message') throw new Error('input-message start requires user/message')
    const event = match.event
    if (event.data.source.kind !== 'user') {
      const nextTurn = reader.previous<InboxState>('inbox-next-turn')?.state
      const nextStep = reader.previous<InboxState>('inbox-next-step')?.state
      const location = match.location
      const turnStart = location.kind === 'step' ? location.turn.start?.seq : undefined
      // An idle steer opens Step 1 without a next-turn claim in this Turn.
      // A human in that same next-step claim owns the opening instead of its notices.
      const idleSteer = location.kind === 'step' && location.step.step === 1
        && turnStart !== undefined && (nextStep?.claimSeq ?? -1) > turnStart
        && (nextTurn?.claimSeq ?? -1) < turnStart && nextStep?.claimedHuman === false
        && nextStep.currentClaimed.has(String(event.data.id))

      return {
        kind: 'context',
        waking: nextTurn?.currentClaimed.has(String(event.data.id)) === true || idleSteer,
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        producer: contextProducer(event.data.source),
        form: contextForm(event.data.source),
      }
    }
    const claimed = reader.previous<InboxState>('inbox-next-step')
      ?.state.currentClaimed.has(String(event.data.id)) === true
    const branch = replacedBranch(event)
    const replaced = branch === undefined ? {} : { replacedBranch: branch }
    return claimed
      ? {
        kind: 'steering',
        messageId: event.data.id,
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        ...replaced,
      }
      : {
        kind: 'user',
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        ...replaced,
      }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const waking = context.state.kind === 'context'
      && context.start?.event.type === 'user/message'
      && context.state.waking === true
    return chatNode(context, waking ? 'turn-trigger' : context.state.kind, context.state.seq, context.state)
  },
}

/**
 * Register the user, steering, and injected-context message contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerMessageConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(messageDefinition)
}
