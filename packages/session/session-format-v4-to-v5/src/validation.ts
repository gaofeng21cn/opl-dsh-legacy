/** V5 admission and restoration rules for the expanded producer source vocabulary. */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact } from '@deepseek-ai/dsh-session-format'
import { assertV4RowAdmission, assertReleasedV4Header, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'

/** Validate the V5 header while reusing the stable V4 header shape.
 * @param header - Untrusted V5 header.
 */
export function assertReleasedV5Header(header: unknown): void {
  if (!isSessionFormatJsonObject(header) || header['version'] !== 5) throw new SessionFormatError('expected format v5 header')
  assertReleasedV4Header({ ...header, version: 4 })
}

/** V5 keeps V4 row admission; the current Session owns the new source kind.
 * @param row - Untrusted physical row.
 */
export function assertV5RowAdmission(row: unknown): void {
  assertV4RowAdmission(row)
}

/** Restore a V5 artifact using V4 generation invariants and the installed current vocabulary.
 * @param artifact - Complete decoded V5 artifact.
 * @param knownEventTypes - Installed event vocabulary.
 * @returns the unchanged validated artifact.
 */
export function restoreReleasedV5Artifact(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): SessionFormatArtifact {
  assertReleasedV5Header(artifact.header)
  // Only the validation view remaps generations. Stored delivery watermarks
  // remain unchanged: V4 acknowledgements are inactive in a V5 file.
  const events = artifact.events.map((event) => {
    if (event.type !== 'session-log-deepseek/delivery-accepted' || !isSessionFormatJsonObject(event.data)) return event
    const version = event.data['sessionFormatVersion']
    if (version !== 4 && version !== 5) return event
    return { ...event, data: { ...event.data, sessionFormatVersion: version === 5 ? 4 : 3 } }
  })
  restoreReleasedV4Artifact({ ...artifact, events, header: { ...artifact.header, version: 4 } }, knownEventTypes)
  return artifact
}
