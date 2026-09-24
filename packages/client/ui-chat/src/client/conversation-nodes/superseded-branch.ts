import type { ChatConversationViewNode, ChatNode } from '../contract/chat-nodes.ts'

/**
 * Prompt branch a landed surface replacement superseded: the replaced prompt's
 * own surface node through everything logged before the replacement.
 *
 * A `rewrite` producer (edit-and-resend) declares this on its replacement
 * `user/message`, whose `sourceEventSeqs` carries the same range as surface
 * nodes. The durable log keeps every superseded event, so this range only
 * selects transcript rows to hide — it never deletes history.
 */
export interface SupersededBranch {
  /** Log position of the superseded prompt's own surface node. */
  readonly startSeq: number
  /** The replacement event's seq; its own row and later events belong to the new generation. */
  readonly untilSeq: number
}

/**
 * Branch range a message row declares, when that row is a prompt-rewrite
 * replacement or a conversation rewind.
 */
function declaredBranch(node: ChatConversationViewNode): SupersededBranch | undefined {
  const candidate = node as ChatNode
  if (candidate.kind !== 'user' && candidate.kind !== 'steering' && candidate.kind !== 'rewind') return undefined
  return candidate.data.replacedBranch
}

/** Turn owning one materialized row, when it has one. */
function rowTurn(node: ChatConversationViewNode): number | undefined {
  const { location } = node
  return location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : undefined
}

/**
 * Chat's client-side generation filter for landed prompt rewrites.
 *
 * A replacement prompt shadows the branch its predecessor opened on the model
 * surface, and the human transcript follows the current surface generation:
 * rows inside an adopted branch materialize `hidden`, so the renderer, the Turn
 * rail, and the Turn process projection all stop at the new prompt. Compaction
 * checkpoints declare no branch and keep the existing contract that their
 * shadowed rows stay visible; the durable events remain available either way.
 *
 * Adopted branches are never withdrawn: a landed replacement cannot un-land,
 * and a paged window that no longer holds the declaring row still needs the
 * range to materialize the rows it does hold.
 */
export class SupersededBranchFilter {
  private readonly adopted = new Map<number, SupersededBranch>()
  private readonly branches: SupersededBranch[] = []

  /**
   * Adopt every branch these rows declare.
   * @param nodes - Rows materialized by this publication.
   * @returns whether a branch this filter did not already hold arrived.
   */
  adopt(nodes: readonly ChatConversationViewNode[]): boolean {
    let added = false
    for (const node of nodes) {
      const branch = declaredBranch(node)
      if (branch === undefined || this.adopted.has(branch.untilSeq)) continue
      this.adopted.set(branch.untilSeq, branch)
      this.branches.push(branch)
      added = true
    }
    if (added) this.branches.sort((left, right) => left.startSeq - right.startSeq)
    return added
  }

  /**
   * Whether a log position belongs to a superseded branch.
   * @param seq - Row anchor log position.
   * @returns whether an adopted branch covers it.
   */
  superseded(seq: number): boolean {
    for (const branch of this.branches) {
      if (branch.startSeq > seq) break
      if (seq < branch.untilSeq) return true
    }
    return false
  }

  /**
   * Materialize rows under the adopted branches.
   * @param nodes - Rows to materialize.
   * @returns Superseded rows hidden; every other row keeps its reference.
   */
  hide(nodes: readonly ChatConversationViewNode[]): readonly ChatConversationViewNode[] {
    let hidden: ChatConversationViewNode[] | undefined
    for (const [index, node] of nodes.entries()) {
      if (node.visibility !== 'visible' || !this.superseded(node.anchorSeq)) continue
      hidden ??= [...nodes]
      hidden[index] = { ...node, visibility: 'hidden' }
    }
    return hidden ?? nodes
  }

  /**
   * Loaded Turns whose every materialized row a superseded branch hid.
   *
   * The whole-log `turnOutline` projection names these Turns too, so the rail
   * caller needs them to drop marks that have no row left to scroll to. A Turn
   * keeps a mark while any row survives — replacing a steering message hides
   * only the Turn's later rows.
   * @param nodes - Rows currently materialized for the Chat target.
   * @returns Turn numbers with at least one superseded row and no visible row.
   */
  supersededTurns(nodes: readonly ChatConversationViewNode[]): ReadonlySet<number> {
    const visible = new Set<number>()
    const replaced = new Set<number>()
    for (const node of nodes) {
      const turn = rowTurn(node)
      if (turn === undefined) continue
      if (node.visibility === 'visible') visible.add(turn)
      else if (this.superseded(node.anchorSeq)) replaced.add(turn)
    }
    for (const turn of visible) replaced.delete(turn)
    return replaced
  }
}
