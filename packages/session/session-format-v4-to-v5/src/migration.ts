/** Identity V4→V5 stage: preserve every event and only advance the generation marker. */

import { defineSessionFormatMigration } from '@deepseek-ai/dsh-session-format'
import { isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatMigrationContext, SessionFormatMigrationStage, SessionFormatMigrationStageInput, SessionFormatEventRun, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { assertReleasedV5Header } from './validation.ts'

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
  private inheritedCut: number | undefined

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    if (input.sourceInheritedEventCount !== undefined) this.headerInheritedEventCount = input.sourceInheritedEventCount
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data) && event.data['inherited'] === true) {
      this.inheritedCut = event.seq
    }
    context.emitEvent(event)
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    context.emitRun(run)
  }

  finish(): number {
    return this.input.sourceInheritedEventCount ?? this.inheritedCut ?? 0
  }
}
