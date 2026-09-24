/**
 * Superseded transcript generations: a landed prompt rewrite and a conversation
 * rewind both hide the rows of the branch they replaced while the durable log
 * keeps them, and a compaction checkpoint keeps its existing does-not-erase
 * contract.
 */

import { describe, expect, it } from 'vitest'
import type {
  ChatConversationViewNode, ChatSnapshot,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  SessionEventLikeEntry, SessionLiveEventEntry,
} from '@deepseek-ai/dsh-api-session-controller/client'
import {
  ConversationNodeAssembler,
  type ConversationNodeDefinition,
  type ConversationViewDefinition,
  inspectRequestPrompt,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { AssistantChatData, ToolChatData } from '../src/client/contract/chat-nodes.ts'
import { assistantDefinition } from '../src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { commandDefinition } from '../src/client/conversation-nodes/command.ts'
import { compactionDefinition } from '../src/client/conversation-nodes/compaction.ts'
import { unknownFallbackDefinition } from '../src/client/conversation-nodes/fallback.ts'
import { nextStepInboxDefinition } from '../src/client/conversation-nodes/inbox.ts'
import { messageDefinition } from '../src/client/conversation-nodes/message.ts'
import { requestPromptDefinition, systemMessageDefinition } from '../src/client/conversation-nodes/request-prompt.ts'
import { retryDefinition } from '../src/client/conversation-nodes/retry.ts'
import { toolDefinition } from '../src/client/conversation-nodes/tool.ts'
import { turnErrorDefinition } from '../src/client/conversation-nodes/turn-error.ts'
import { turnMaxTokensDefinition } from '../src/client/conversation-nodes/turn-max-tokens.ts'
import { turnTailDefinition } from '../src/client/conversation-nodes/turn-tail.ts'
import { turnProcessDefinition } from '../src/client/conversation-nodes/turn-process.ts'
import { inspectSystemPrompt } from '../../ui-conversation/src/client/contract/system-prompt.ts'
import { SupersededBranchFilter } from '../src/client/conversation-nodes/superseded-branch.ts'

const DEFINITIONS: readonly ConversationNodeDefinition[] = [
  nextStepInboxDefinition,
  messageDefinition,
  systemMessageDefinition(inspectSystemPrompt),
  requestPromptDefinition(inspectRequestPrompt),
  assistantDefinition,
  turnProcessDefinition,
  toolDefinition,
  commandDefinition,
  compactionDefinition,
  retryDefinition,
  turnErrorDefinition,
  turnMaxTokensDefinition,
  turnTailDefinition,
]

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return DEFINITIONS
  }

  fallbackEntry(): ConversationNodeDefinition {
    return unknownFallbackDefinition
  }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [chatViewDefinition]
  }
}

function at(
  seq: number,
  type: string,
  data: unknown,
  extra: Record<string, unknown> = {},
): SessionLiveEventEntry {
  const payload = type === 'assistant/message' && typeof data === 'object' && data !== null
    ? { ...(data as Record<string, unknown>), stream: [] }
    : data
  return {
    type: 'event',
    event: {
      seq,
      time: 1_700_000_000_000 + seq,
      type,
      data: payload,
      ...extra,
    } as unknown as SessionEvent,
  }
}

function assembler(entries: readonly SessionEventLikeEntry[] = [], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(entries, hasMore)
  value.activateTarget('chat')
  return value
}

/** Append every entry one at a time, publishing after each, like the live transport. */
function live(entries: readonly SessionEventLikeEntry[]): ConversationNodeAssembler {
  const value = assembler()
  for (const entry of entries) {
    value.append(entry)
    value.flush()
  }
  return value
}

function snapshot(value: ConversationNodeAssembler): ChatSnapshot {
  const current = value.snapshot('chat') as ChatSnapshot | undefined
  if (current === undefined) throw new Error('chat view was not registered')
  return current
}

function orderKinds(value: ChatSnapshot): readonly string[] {
  return value.order.map(key => value.nodes.get(key)?.kind ?? 'missing')
}

function turnsInOrder(value: ChatSnapshot): readonly number[] {
  return value.order.flatMap((key) => {
    const location = value.nodes.get(key)?.location
    if (location === undefined || (location.kind !== 'turn' && location.kind !== 'step')) return []
    return [location.turn.turn]
  })
}

function textMessage(id: string, text: string) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function assistantMessage(id: string, text: string) {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'fake', model: 'fake' },
  }
}

function toolResult(callId: string, text: string) {
  return {
    id: `result-${callId}`,
    role: 'tool',
    source: { kind: 'tool', callId },
    content: [{ type: 'text', text }],
    isError: false,
  }
}

/** One completed Turn that opened with its own prompt, answer, Tool call, and result. */
function promptedTurn(start: number, turn: number, prompt: string, answer: string, callId: string): SessionLiveEventEntry[] {
  return [
    at(start, 'turn/start', { turn }),
    at(start + 1, 'step/start', { turn, step: 1 }),
    at(start + 2, 'user/message', textMessage(`user-${String(turn)}`, prompt), { surfaceOp: 'append' }),
    at(start + 3, 'assistant/message', {
      turn, step: 1, message: assistantMessage(`assistant-${String(turn)}`, answer),
    }, { surfaceOp: 'append' }),
    at(start + 4, 'tool/call', { turn, step: 1, callId, name: 'read', arguments: '{}' }),
    at(start + 5, 'tool/result', {
      turn, step: 1, message: toolResult(callId, `${answer} tool output`),
    }, { surfaceOp: 'append' }),
    at(start + 6, 'step/end', { turn, step: 1 }),
    at(start + 7, 'turn/end', { turn, reason: { kind: 'completed' } }),
  ]
}

/**
 * One completed Turn whose prompt was already on the surface: the loop skips
 * appending the claimed message an edit-and-resend replacement landed, so the
 * Turn holds steps without a `user/message` of its own.
 */
function answeringTurn(start: number, turn: number, answer: string): SessionLiveEventEntry[] {
  return [
    at(start, 'turn/start', { turn }),
    at(start + 1, 'step/start', { turn, step: 1 }),
    at(start + 2, 'assistant/message', {
      turn, step: 1, message: assistantMessage(`assistant-${String(turn)}`, answer),
    }, { surfaceOp: 'append' }),
    at(start + 3, 'step/end', { turn, step: 1 }),
    at(start + 4, 'turn/end', { turn, reason: { kind: 'completed' } }),
  ]
}

/**
 * Turn 1 stays; Turn 2's prompt (seq 11) is edited at seq 17, which replaces its
 * whole branch (11, 12, 14) with the new prompt and opens Turn 3 (18-22).
 */
const EDITED_HISTORY: readonly SessionLiveEventEntry[] = [
  ...promptedTurn(1, 1, 'first question', 'first answer', 'call-1'),
  ...promptedTurn(9, 2, 'second question', 'second answer', 'call-2'),
  at(17, 'user/message', textMessage('user-edited', 'edited question'), {
    surfaceOp: { op: 'replace', startSeq: 11, endSeq: 14 },
    sourceEventSeqs: [11, 12, 14],
  }),
  ...answeringTurn(18, 3, 'new answer'),
]

function nodeAt(value: ChatSnapshot, kind: string, seq: number): ChatConversationViewNode | undefined {
  return value.nodes.values().find(candidate => candidate.kind === kind && candidate.anchorSeq === seq)
}

/** Visible order of both Turns, before an edit lands. */
const OPENED_KINDS = [
  'user', 'turn-process', 'assistant-step', 'tool-call', 'turn-tail',
  'user', 'turn-process', 'assistant-step', 'turn-tail',
]

describe('prompt-rewrite transcript generations', () => {
  it('hides the replaced branch and shows the new prompt with its Turn', () => {
    const current = snapshot(assembler(EDITED_HISTORY))

    expect(orderKinds(current)).toEqual(OPENED_KINDS)
    // The replacement row is logged before its Turn starts, so it carries the
    // session Location while the abandoned Turn loses every row.
    expect(turnsInOrder(current)).toEqual([1, 1, 1, 1, 1, 3, 3, 3])
    expect(current.supersededTurns).toEqual(new Set([2]))
    expect(current.navigation.items().map(item => item.turn)).toEqual([1, 3])
  })

  it('hides the same rows whether the rewrite lands live or the session is reopened', () => {
    const replayed = snapshot(assembler(EDITED_HISTORY))
    const streamed = snapshot(live(EDITED_HISTORY))

    expect(orderKinds(streamed)).toEqual(OPENED_KINDS)
    expect(streamed.supersededTurns).toEqual(replayed.supersededTurns)
    // Every row stays visible until the replacement lands.
    const opened = snapshot(live(EDITED_HISTORY.slice(0, 16)))
    expect(turnsInOrder(opened)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2])
    expect(opened.supersededTurns.size).toBe(0)
  })

  it('keeps the replaced rows readable in the durable log', () => {
    const current = snapshot(assembler(EDITED_HISTORY))
    const prompt = nodeAt(current, 'user', 11)
    const answer = current.nodes.values()
      .find(candidate => candidate.kind === 'assistant-step'
        && (candidate.data as AssistantChatData).finalNode?.seq === 12)
    const tool = nodeAt(current, 'tool-call', 13)

    expect(prompt?.visibility).toBe('hidden')
    expect(prompt?.data).toMatchObject({ content: [{ type: 'text', text: 'second question' }] })
    expect(answer?.visibility).toBe('hidden')
    expect((answer?.data as AssistantChatData).blocks).toEqual([{ kind: 'text', text: 'second answer' }])
    expect(tool?.visibility).toBe('hidden')
    expect(((tool?.data as ToolChatData).root as { content: unknown }).content)
      .toEqual([{ type: 'text', text: 'second answer tool output' }])
  })

  it('hides the branch when its older events arrive from a prepended page', () => {
    const tail = assembler(EDITED_HISTORY.slice(15), true)
    expect(turnsInOrder(snapshot(tail))).toEqual([3, 3, 3])

    tail.prepend(EDITED_HISTORY.slice(0, 15), false)
    tail.flush()

    const current = snapshot(tail)
    expect(orderKinds(current)).toEqual(OPENED_KINDS)
    expect(current.supersededTurns).toEqual(new Set([2]))
  })

  it('hides only the branch the newest rewrite replaced across repeated edits', () => {
    const second: readonly SessionLiveEventEntry[] = [
      ...EDITED_HISTORY,
      at(23, 'user/message', textMessage('user-edited-again', 'edited again'), {
        surfaceOp: { op: 'replace', startSeq: 17, endSeq: 20 },
        sourceEventSeqs: [17, 20],
      }),
      ...answeringTurn(24, 4, 'newest answer'),
    ]
    const current = snapshot(assembler(second))

    expect(turnsInOrder(current)).toEqual([1, 1, 1, 1, 1, 4, 4, 4])
    expect(current.supersededTurns).toEqual(new Set([2, 3]))
    // Both prompts stay readable; only the newest is on screen.
    expect(nodeAt(current, 'user', 17)?.visibility).toBe('hidden')
    expect(nodeAt(current, 'user', 23)?.visibility).toBe('visible')
    expect(current.navigation.items().map(item => item.turn)).toEqual([1, 4])
  })

  it('keeps a Turn whose earlier rows a steering rewrite did not replace', () => {
    const steering = textMessage('steering-1', 'change direction')
    const history: readonly SessionLiveEventEntry[] = [
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'user/message', textMessage('user-1', 'opening question'), { surfaceOp: 'append' }),
      at(4, 'assistant/message', {
        turn: 1, step: 1, message: assistantMessage('assistant-1', 'opening answer'),
      }, { surfaceOp: 'append' }),
      at(5, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [steering] }),
      at(6, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }),
      at(7, 'user/message', steering, { surfaceOp: 'append' }),
      at(8, 'assistant/message', {
        turn: 1, step: 1, message: assistantMessage('assistant-2', 'steered answer'),
      }, { surfaceOp: 'append' }),
      at(9, 'step/end', { turn: 1, step: 1 }),
      at(10, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      at(11, 'user/message', textMessage('steering-edited', 'edited direction'), {
        surfaceOp: { op: 'replace', startSeq: 7, endSeq: 8 },
        sourceEventSeqs: [7, 8],
      }),
      at(12, 'turn/start', { turn: 2 }),
      at(13, 'step/start', { turn: 2, step: 1 }),
      at(14, 'assistant/message', {
        turn: 2, step: 1, message: assistantMessage('assistant-3', 'new direction answer'),
      }, { surfaceOp: 'append' }),
      at(15, 'step/end', { turn: 2, step: 1 }),
      at(16, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]
    const current = snapshot(assembler(history))

    // Turn 1 keeps its opening rows, so it keeps its rail mark; only the
    // steered tail rows and the replacement are hidden.
    expect(nodeAt(current, 'steering', 7)?.visibility).toBe('hidden')
    expect(nodeAt(current, 'user', 11)?.visibility).toBe('visible')
    expect(nodeAt(current, 'user', 3)?.visibility).toBe('visible')
    expect(current.supersededTurns.size).toBe(0)
    expect(current.navigation.items().map(item => item.turn)).toEqual([1, 2])
  })

  it('keeps a compaction checkpoint from hiding the rows it shadowed', () => {
    const history: readonly SessionLiveEventEntry[] = [
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'user/message', textMessage('user-1', 'summarized question'), { surfaceOp: 'append' }),
      at(4, 'assistant/message', {
        turn: 1, step: 1, message: assistantMessage('assistant-1', 'summarized answer'),
      }, { surfaceOp: 'append' }),
      at(5, 'step/end', { turn: 1, step: 1 }),
      at(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      at(7, 'compaction/start', { compactionId: 'compact-1', turn: null }),
      at(8, 'compaction/summary', {
        compactionId: 'compact-1',
        summary: [{ type: 'text', text: 'summary' }],
        shadowedSeqs: [3, 4],
        shadowedTokenCount: 42,
      }),
      at(9, 'user/message', {
        ...textMessage('checkpoint-1', 'checkpoint'),
        source: { kind: 'compact-checkpoint', compactionId: 'compact-1' },
      }, { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 }, sourceEventSeqs: [3, 4] }),
      at(10, 'compaction/end', { compactionId: 'compact-1', turn: null }),
    ]
    const current = snapshot(assembler(history))

    // The marker reports where the model stopped seeing the history; the
    // shadowed rows stay in the transcript.
    expect(nodeAt(current, 'user', 3)?.visibility).toBe('visible')
    expect(orderKinds(current)).toEqual(['user', 'turn-process', 'assistant-step', 'turn-tail', 'compaction'])
    expect(current.supersededTurns.size).toBe(0)
  })
})

describe('conversation rewind generations', () => {
  /** The empty `developer/message` a rewind appends over the branch it removed. */
  function rewindAt(seq: number, startSeq: number, endSeq: number, shadowed: readonly number[]): SessionLiveEventEntry {
    return at(seq, 'developer/message', {
      turn: 2,
      step: 1,
      message: {
        id: `rewind-${String(seq)}`,
        role: 'developer',
        content: [],
        source: { kind: 'rewind' },
      },
    }, {
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: [...shadowed],
    })
  }

  /** Turn 2's whole branch — its prompt, answer, and tool result — leaves the surface at seq 17. */
  const REWOUND_HISTORY: readonly SessionLiveEventEntry[] = [
    ...promptedTurn(1, 1, 'first question', 'first answer', 'call-1'),
    ...promptedTurn(9, 2, 'second question', 'second answer', 'call-2'),
    rewindAt(17, 11, 14, [11, 12, 14]),
  ]

  it('materializes a rewind marker declaring the branch it removed', () => {
    const current = snapshot(assembler(REWOUND_HISTORY))
    const marker = nodeAt(current, 'rewind', 17)

    expect(marker?.visibility).toBe('visible')
    expect(marker?.data).toEqual({ seq: 17, replacedBranch: { startSeq: 11, untilSeq: 17 } })
  })

  it('hides the rewound branch while the durable rows stay readable', () => {
    const current = snapshot(assembler(REWOUND_HISTORY))

    expect(nodeAt(current, 'user', 11)?.visibility).toBe('hidden')
    expect(nodeAt(current, 'user', 11)?.data).toMatchObject({ content: [{ type: 'text', text: 'second question' }] })
    const answer = current.nodes.values()
      .find(candidate => candidate.kind === 'assistant-step'
        && (candidate.data as AssistantChatData).finalNode?.seq === 12)
    const tool = nodeAt(current, 'tool-call', 13)
    expect(answer?.visibility).toBe('hidden')
    expect((answer?.data as AssistantChatData).blocks).toEqual([{ kind: 'text', text: 'second answer' }])
    expect(tool?.visibility).toBe('hidden')
    // The Turn before the rewound one keeps every row.
    expect(nodeAt(current, 'user', 3)?.visibility).toBe('visible')
    expect(turnsInOrder(current).slice(0, 5)).toEqual([1, 1, 1, 1, 1])
  })

  it('hides the branch whether the rewind lands live or the session is reopened', () => {
    const replayed = snapshot(assembler(REWOUND_HISTORY))
    const streamed = snapshot(live(REWOUND_HISTORY))

    expect(streamed.supersededTurns).toEqual(replayed.supersededTurns)
    // Every row stays visible until the marker lands.
    const opened = snapshot(live(REWOUND_HISTORY.slice(0, 16)))
    expect(opened.supersededTurns.size).toBe(0)
    expect(nodeAt(opened, 'user', 11)?.visibility).toBe('visible')
    expect(nodeAt(opened, 'rewind', 17)).toBeUndefined()
  })

  it('keeps a Turn whose rows the rewind did not shadow', () => {
    const history: readonly SessionLiveEventEntry[] = [
      ...promptedTurn(1, 1, 'kept question', 'kept answer', 'call-1'),
      at(9, 'user/message', textMessage('user-2', 'rewound question'), { surfaceOp: 'append' }),
      // The branch starts at the prompt itself: the earlier Turn keeps every row.
      rewindAt(10, 9, 9, [9]),
    ]
    const current = snapshot(assembler(history))

    expect(nodeAt(current, 'user', 3)?.visibility).toBe('visible')
    expect(nodeAt(current, 'user', 9)?.visibility).toBe('hidden')
    expect(nodeAt(current, 'rewind', 10)?.visibility).toBe('visible')
  })
})

describe('SupersededBranchFilter', () => {
  function row(anchorSeq: number, visibility: 'visible' | 'hidden' = 'visible'): ChatConversationViewNode {
    return {
      key: `row:${String(anchorSeq)}`,
      id: String(anchorSeq),
      target: 'chat',
      kind: 'user',
      anchorSeq,
      location: { kind: 'session' },
      visibility,
      data: { kind: 'user', seq: anchorSeq, time: anchorSeq, content: [], source: { kind: 'user' } },
    }
  }

  function rewrite(untilSeq: number, startSeq: number): ChatConversationViewNode {
    return {
      ...row(untilSeq),
      data: {
        kind: 'user',
        seq: untilSeq,
        time: untilSeq,
        content: [],
        source: { kind: 'user' },
        replacedBranch: { startSeq, untilSeq },
      },
    }
  }

  it('covers each declared range from its start up to, but not including, the replacement row', () => {
    const filter = new SupersededBranchFilter()

    expect(filter.adopt([rewrite(9, 3)])).toBe(true)
    expect(filter.adopt([rewrite(9, 3)])).toBe(false)
    expect(filter.superseded(3)).toBe(true)
    expect(filter.superseded(8)).toBe(true)
    expect(filter.superseded(9)).toBe(false)
    expect(filter.superseded(2)).toBe(false)
    expect(filter.hide([row(9)])[0]?.visibility).toBe('visible')
    expect(filter.hide([row(3)])[0]?.visibility).toBe('hidden')
    expect(filter.hide([row(3, 'hidden')])[0]?.visibility).toBe('hidden')
  })

  it('reports only Turns whose rows are all superseded', () => {
    const filter = new SupersededBranchFilter()
    filter.adopt([rewrite(9, 3)])
    const turn = (anchorSeq: number, turnNumber: number, visibility: 'visible' | 'hidden'): ChatConversationViewNode => ({
      ...row(anchorSeq, visibility),
      location: {
        kind: 'turn',
        turn: {
          turn: turnNumber,
          status: 'closed',
          steps: [],
          data: { get: () => undefined, source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) },
        },
      } as never,
    })

    expect(filter.supersededTurns([turn(3, 1, 'hidden'), turn(4, 1, 'hidden')])).toEqual(new Set([1]))
    expect(filter.supersededTurns([turn(3, 1, 'hidden'), turn(5, 1, 'visible')])).toEqual(new Set())
    expect(filter.supersededTurns([turn(20, 2, 'hidden')])).toEqual(new Set())
  })
})
