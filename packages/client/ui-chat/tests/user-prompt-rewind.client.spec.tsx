// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ConversationNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ChatNodeViewProps, ChatPromptRewindFailure } from '../src/client/contract/slots.ts'
import { UserMessageNodeView } from '../src/client/chat/MessageItem.tsx'
import { zh } from '../src/client/locale.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t: ChatNodeViewProps['t'] = makeTranslate(zh, commonZh)
const REWIND = '回退到这条消息之前'
const EDIT = '编辑并重发'

function promptNode(seq: number, text: string): Extract<ConversationNode, { kind: 'user' }> {
  return {
    kind: 'user',
    seq,
    time: 1_000,
    content: [{ type: 'text', text }] as never,
    source: null,
  }
}

interface RewindRowOptions {
  readonly seq?: number
  readonly text?: string
  readonly editablePromptSeq?: number
  readonly running?: boolean
  readonly rewindPrompt?: (seq: number, text: string) => Promise<ChatPromptRewindFailure | null>
}

/** Render one durable user row with the owner currency the Chat view supplies. */
function renderUserRow(options: RewindRowOptions = {}): { rewindPrompt: ReturnType<typeof vi.fn> } {
  const seq = options.seq ?? 7
  const node = promptNode(seq, options.text ?? 'original text')
  const rewindPrompt = vi.fn(options.rewindPrompt ?? (() => Promise.resolve(null)))
  const useSession = bindSnapshotSelector({
    subscribe: () => () => {},
    getSnapshot: () => ({ running: options.running ?? false }),
  })
  const props = {
    node: {
      key: `fixture:user:${String(seq)}`,
      kind: 'user',
      id: String(seq),
      target: 'chat',
      anchorSeq: seq,
      location: { kind: 'session' },
      visibility: 'visible',
      data: node,
    },
    t,
    renderMessageImages: () => null,
    openFile: vi.fn(),
    openSkill: vi.fn(),
    useChat: bindSnapshotSelector({ subscribe: () => () => {}, getSnapshot: () => ({}) }),
    useSession,
    ...options.editablePromptSeq === undefined ? {} : { editablePromptSeq: options.editablePromptSeq },
    editPrompt: () => Promise.resolve(null),
    rewindPrompt,
  } as unknown as ChatNodeViewProps<'user' | 'steering'>
  render(<UserMessageNodeView {...props} />)
  return { rewindPrompt }
}

const rewindAction = (): HTMLElement => screen.getByRole('button', { name: REWIND })

describe('user prompt rewind', () => {
  it('offers the rewind action only for the addressed last prompt', () => {
    renderUserRow({ seq: 7, editablePromptSeq: 3 })
    expect(screen.queryByRole('button', { name: REWIND })).toBeNull()

    cleanup()
    renderUserRow({ seq: 7, editablePromptSeq: 7 })
    expect(rewindAction()).toBeTruthy()
  })

  it('hides the rewind action while a turn is running', () => {
    renderUserRow({ seq: 7, editablePromptSeq: 7, running: true })
    expect(screen.queryByRole('button', { name: REWIND })).toBeNull()
    expect(screen.queryByRole('button', { name: EDIT })).toBeNull()
  })

  it('keeps the edit action beside it for the same row', () => {
    renderUserRow({ seq: 7, editablePromptSeq: 7 })
    expect(screen.getByRole('button', { name: EDIT })).toBeTruthy()
    expect(rewindAction()).toBeTruthy()
  })

  it('rewinds the addressed prompt with its durable text', async () => {
    const { rewindPrompt } = renderUserRow({ editablePromptSeq: 7, text: 'roll me back' })

    fireEvent.click(rewindAction())

    await waitFor(() => { expect(rewindPrompt).toHaveBeenCalledWith(7, 'roll me back') })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports the localized refusal without offering the draft', async () => {
    renderUserRow({
      editablePromptSeq: 7,
      rewindPrompt: () => Promise.resolve({ code: 'session/rewind-unavailable', reason: 'busy' }),
    })

    fireEvent.click(rewindAction())

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('会话正在运行，请等它结束后再回退。') })
    expect(screen.queryByRole('textbox', { name: '编辑这条用户消息' })).toBeNull()
  })

  it('reports a transport failure with the generic line', async () => {
    renderUserRow({
      editablePromptSeq: 7,
      rewindPrompt: () => Promise.reject(new Error('offline')),
    })

    fireEvent.click(rewindAction())

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('回退失败，请重试。') })
  })
})
