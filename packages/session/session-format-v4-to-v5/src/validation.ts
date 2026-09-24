/** V5 admission and restoration rules for the expanded producer source vocabulary. */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact } from '@deepseek-ai/dsh-session-format'
import { assertV4RowAdmission, assertReleasedV4Header, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'

/** Validate the V5 header while reusing the stable V4 header shape. */
export function assertReleasedV5Header(header: unknown): void {
  if (!isSessionFormatJsonObject(header) || header['version'] !== 5) throw new SessionFormatError('expected format v5 header')
  assertReleasedV4Header({ ...header, version: 4 })
}

/** V5 keeps V4 row admission; the current Session owns the new source kind. */
export function assertV5RowAdmission(row: unknown): void {
  assertV4RowAdmission(row)
}

/** Restore a V5 artifact using V4 generation invariants and the installed current vocabulary. */
export function restoreReleasedV5Artifact(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): SessionFormatArtifact {
  assertReleasedV5Header(artifact.header)
  restoreReleasedV4Artifact({ ...artifact, header: { ...artifact.header, version: 4 } }, knownEventTypes)
  return artifact
}
