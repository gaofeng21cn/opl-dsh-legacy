/** Identity V4→V5 stage: preserve every event and only advance the generation marker. */

import { SessionFormatUnsupportedMigrationError, defineSessionFormatMigration } from '@deepseek-ai/dsh-session-format'
import { isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatMigrationContext, SessionFormatMigrationStage, SessionFormatMigrationStageInput, SessionFormatEventRun, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { RELEASED_V4_EVENT_TYPES } from './v4-vocabulary.ts'
import { assertReleasedV5Header } from './validation.ts'

/** Preserve V4 events while advancing the physical writer generation. */
export const sessionFormatV4ToV5 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v4-to-v5',
  fromVersion: 4,
  toVersion: 5,
  migrateHeader(header) {
    assertReleasedV4Header(header)
    return { ...header, version: 5 }
  },
  createStage: input => new IdentityV4ToV5Stage(input),
  validateTargetHeader: assertReleasedV5Header,
})

class IdentityV4ToV5Stage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private readonly events: SessionFormatEvent[] = []
  private inheritedCut: number | undefined

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    if (input.sourceInheritedEventCount !== undefined) this.headerInheritedEventCount = input.sourceInheritedEventCount
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.type === 'session-log-deepseek/delivery-accepted' && isSessionFormatJsonObject(event.data) && event.data['sessionFormatVersion'] === 5) {
      throw new SessionFormatUnsupportedMigrationError('format v4 delivery marker claims target format v5')
    }
    this.events.push(event)
    if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data) && event.data['inherited'] === true) {
      this.inheritedCut = event.seq
    }
    context.emitEvent(event)
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    for (const event of run.expand()) this.transformEvent(event, context)
  }

  finish(): number {
    const cut = this.input.sourceInheritedEventCount ?? this.inheritedCut ?? 0
    restoreReleasedV4Artifact({ header: this.input.sourceHeader, events: this.events, inheritedEventCount: cut }, RELEASED_V4_EVENT_TYPES)
    return cut
  }
}
