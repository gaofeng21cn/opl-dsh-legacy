import type { ChatNodeViewProps } from '../contract/slots.ts'
import { IconUndoOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './RewindMarker.module.css'

/**
 * Render one durable conversation-rewind marker.
 *
 * The row is the transcript's only trace of a rewind that removed a prompt's
 * branch: the shadowed rows leave the current generation while the marker keeps
 * the position and the fact visible, and every removed event stays in the log.
 * @param props - the marker node and the locale seat.
 * @returns the rewind marker row.
 */
export function RewindMarker({ node, t }: ChatNodeViewProps<'rewind'>) {
  return (
    <div className={css.row} data-rewind-marker={node.data.seq}>
      <IconUndoOutlineRegular size={14} className={css.icon} />
      <span className={css.text} role="status">{t('message.rewind.marker')}</span>
    </div>
  )
}
