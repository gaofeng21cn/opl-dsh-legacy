/** Generation-specific delivery watermarks and inherited cuts must survive migration safely. */
import { describe, expect, it } from 'vitest'
import type { SessionFormatArtifact, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { sessionFormatV4ToV5, restoreReleasedV5Artifact } from '../src/index.ts'
const header = { version: 4, id: 'parent', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const known = new Set(['session-log-deepseek/delivery-accepted', 'session/end-seed'])
const marker = (version: number, throughSeq = 0, sessionId = 'parent'): SessionFormatEvent => ({
  type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 2, data: { sessionFormatVersion: version, throughSeq, sessionId },
})
const opaque: SessionFormatEvent = { seq: 0, time: 1, type: 'test/opaque', ignorable: true, data: {} }
function artifact(event: SessionFormatEvent): SessionFormatArtifact {
  return { header: { ...header, version: 5 }, inheritedEventCount: 0, events: [opaque, event] }
}
describe('V4 to V5 migration', () => {
  it('rejects a source marker that would become active in the target generation', () => {
    const stage = sessionFormatV4ToV5.createStage({ sourceHeader: header, targetHeader: { ...header, version: 5 }, sourceInheritedEventCount: 0, sourceKind: 'decoded' })
    expect(() => stage.transformEvent(marker(5), { emitEvent() {}, emitRun() {} })).toThrow(/target format v5/)
  })
  it('observes inherited markers inside compact runs', () => {
    const sourceHeader = { ...header, isSeeded: true, parentSession: 'ancestor' }
    const stage = sessionFormatV4ToV5.createStage({ sourceHeader, targetHeader: { ...sourceHeader, version: 5 }, sourceInheritedEventCount: undefined, sourceKind: 'decoded' })
    const events = [opaque, { seq: 1, time: 2, type: 'session/end-seed', data: { inherited: true } }]
    const emitted: SessionFormatEvent[] = []
    const context = { emitEvent: (event: SessionFormatEvent) => { emitted.push(event) }, emitRun() { throw new Error('must inspect run') } }
    stage.transformRun!({ runType: 'fixture', firstSeq: 0, eventCount: 2, expand: () => events }, context)
    expect(stage.finish(context)).toBe(1)
    expect(emitted).toEqual(events)
  })
  it('validates V5 watermarks against the owning Session and sequence', () => {
    expect(() => restoreReleasedV5Artifact(artifact(marker(5, 1)), known)).toThrow(/precede/)
    expect(() => restoreReleasedV5Artifact(artifact(marker(5, 0, 'wrong')), known)).toThrow(/wrong Session/)
    const valid = artifact(marker(5))
    expect(restoreReleasedV5Artifact(valid, known)).toBe(valid)
  })
  it('keeps old-generation markers inactive and never rewrites their bytes', () => {
    const value = artifact(marker(4, 999, 'old-session'))
    const before = JSON.stringify(value)
    restoreReleasedV5Artifact(value, known)
    expect(JSON.stringify(value)).toBe(before)
  })
})
