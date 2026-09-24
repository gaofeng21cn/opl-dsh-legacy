// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ConversationNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ChatNodeViewProps, ChatPromptEditFailure } from '../src/client/contract/slots.ts'
import { UserMessageNodeView } from '../src/client/chat/MessageItem.tsx'
import { zh } from '../src/client/locale.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t: ChatNodeViewProps['t'] = makeTranslate(zh, commonZh)

function promptNode(seq: number, text: string): Extract<ConversationNode, { kind: 'user' }> {
  return {
    kind: 'user',
    seq,
    time: 1_000,
    content: [{ type: 'text', text }] as never,
    source: null,
  }
}

interface EditRowOptions {
  readonly seq?: number
  readonly text?: string
  readonly editablePromptSeq?: number
  readonly running?: boolean
  readonly editPrompt?: (seq: number, text: string) => Promise<ChatPromptEditFailure | null>
}

/** Render one durable user row with the owner currency the Chat view supplies. */
function renderUserRow(options: EditRowOptions = {}): { editPrompt: ReturnType<typeof vi.fn> } {
  const seq = options.seq ?? 7
  const node = promptNode(seq, options.text ?? 'original text')
  const editPrompt = vi.fn(options.editPrompt ?? (() => Promise.resolve(null)))
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
    editPrompt,
  } as unknown as ChatNodeViewProps<'user' | 'steering'>
  render(<UserMessageNodeView {...props} />)
  return { editPrompt }
}

const editAction = (): HTMLElement => screen.getByRole('button', { name: '编辑并重发' })

describe('user prompt edit and resend', () => {
  it('offers the edit action only for the addressed editable prompt', () => {
    renderUserRow({ seq: 7, editablePromptSeq: 3 })
    expect(screen.queryByRole('button', { name: '编辑并重发' })).toBeNull()

    cleanup()
    renderUserRow({ seq: 7, editablePromptSeq: 7 })
    expect(editAction()).toBeTruthy()
  })

  it('hides the edit action while a turn is running', () => {
    renderUserRow({ seq: 7, editablePromptSeq: 7, running: true })
    expect(screen.queryByRole('button', { name: '编辑并重发' })).toBeNull()
  })

  it('opens the draft with the message text, cancels without resending, and keeps the composer untouched', async () => {
    const { editPrompt } = renderUserRow({ editablePromptSeq: 7, text: 'keep me' })
    fireEvent.click(editAction())

    const draft = screen.getByRole('textbox', { name: '编辑这条用户消息' }) as HTMLTextAreaElement
    expect(draft.value).toBe('keep me')

    fireEvent.change(draft, { target: { value: 'discarded' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('textbox', { name: '编辑这条用户消息' })).toBeNull()
    expect(editPrompt).not.toHaveBeenCalled()
    // The bubble still shows the durable text; the draft never touched it.
    expect(screen.getByText('keep me')).toBeTruthy()
  })

  it('closes the draft on Escape without resending', () => {
    const { editPrompt } = renderUserRow({ editablePromptSeq: 7 })
    fireEvent.click(editAction())
    fireEvent.keyDown(screen.getByRole('textbox', { name: '编辑这条用户消息' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: '编辑这条用户消息' })).toBeNull()
    expect(editPrompt).not.toHaveBeenCalled()
  })

  it('resends the edited text and closes once the Host accepts', async () => {
    const { editPrompt } = renderUserRow({ editablePromptSeq: 7, text: 'before' })
    fireEvent.click(editAction())
    const draft = screen.getByRole('textbox', { name: '编辑这条用户消息' })
    fireEvent.change(draft, { target: { value: 'after' } })
    fireEvent.click(screen.getByRole('button', { name: '重发' }))

    await waitFor(() => { expect(screen.queryByRole('textbox', { name: '编辑这条用户消息' })).toBeNull() })
    expect(editPrompt).toHaveBeenCalledWith(7, 'after')
  })

  it('keeps the draft open and reports the localized refusal', async () => {
    renderUserRow({
      editablePromptSeq: 7,
      text: 'before',
      editPrompt: () => Promise.resolve({ code: 'session/edit-unavailable', reason: 'not-last' }),
    })
    fireEvent.click(editAction())
    fireEvent.change(screen.getByRole('textbox', { name: '编辑这条用户消息' }), { target: { value: 'later' } })
    fireEvent.click(screen.getByRole('button', { name: '重发' }))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('只能编辑最后一条用户消息。') })
    const draft = screen.getByRole('textbox', { name: '编辑这条用户消息' }) as HTMLTextAreaElement
    expect(draft.value).toBe('later')
  })

  it('reports a transport failure with the generic line', async () => {
    renderUserRow({
      editablePromptSeq: 7,
      editPrompt: () => Promise.reject(new Error('offline')),
    })
    fireEvent.click(editAction())
    fireEvent.click(screen.getByRole('button', { name: '重发' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('重发失败，请重试。') })
  })
})

describe('user prompt edit draft IME guard', () => {
  const draftBox = (): HTMLElement => screen.getByRole('textbox', { name: '编辑这条用户消息' })

  it('keeps the draft open when Escape closes an IME composition', () => {
    const { editPrompt } = renderUserRow({ editablePromptSeq: 7 })
    fireEvent.click(editAction())

    fireEvent.keyDown(draftBox(), { key: 'Escape', isComposing: true })

    expect(draftBox()).toBeTruthy()
    expect(editPrompt).not.toHaveBeenCalled()
  })

  it('keeps the draft open for the legacy keyCode 229 Escape', () => {
    renderUserRow({ editablePromptSeq: 7 })
    fireEvent.click(editAction())

    fireEvent.keyDown(draftBox(), { key: 'Escape', keyCode: 229 })

    expect(draftBox()).toBeTruthy()
  })

  it('never resends a composition Enter, whichever composition signal carries it', () => {
    const { editPrompt } = renderUserRow({ editablePromptSeq: 7 })
    fireEvent.click(editAction())

    fireEvent.keyDown(draftBox(), { key: 'Enter', metaKey: true, isComposing: true })
    fireEvent.keyDown(draftBox(), { key: 'Enter', ctrlKey: true, keyCode: 229 })
    // jsdom keydowns carry neither signal, so this arm is the draft's own watch.
    fireEvent.compositionStart(draftBox())
    fireEvent.keyDown(draftBox(), { key: 'Enter', metaKey: true })

    expect(editPrompt).not.toHaveBeenCalled()
    expect(draftBox()).toBeTruthy()
  })

  it('resends on Cmd/Ctrl+Enter once the composition window has passed', () => {
    vi.useFakeTimers()
    try {
      const { editPrompt } = renderUserRow({ editablePromptSeq: 7, text: 'after' })
      fireEvent.click(editAction())
      fireEvent.compositionStart(draftBox())
      fireEvent.compositionEnd(draftBox())

      // Safari delivers the composition-closing keydown after compositionend.
      fireEvent.keyDown(draftBox(), { key: 'Enter', metaKey: true })
      expect(editPrompt).not.toHaveBeenCalled()

      vi.advanceTimersByTime(20)
      fireEvent.keyDown(draftBox(), { key: 'Enter', ctrlKey: true })
      expect(editPrompt).toHaveBeenCalledWith(7, 'after')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels on Escape once the composition window has passed', () => {
    vi.useFakeTimers()
    try {
      renderUserRow({ editablePromptSeq: 7 })
      fireEvent.click(editAction())
      fireEvent.compositionEnd(draftBox())
      vi.advanceTimersByTime(20)

      fireEvent.keyDown(draftBox(), { key: 'Escape' })

      expect(screen.queryByRole('textbox', { name: '编辑这条用户消息' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
