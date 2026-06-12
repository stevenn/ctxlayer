/**
 * R2 layout for skill bodies. Same machinery as docs-r2.ts (see
 * revision-store.ts), instantiated under the `skills/` prefix; reuses
 * DOCS_BUCKET.
 *
 *   skills/{skillId}/snapshot.json           -- always reflects current_rev
 *   skills/{skillId}/revisions/{revId}.json  -- immutable per-save copies
 *
 * Body shape is the same BlockNote block tree as docs (DocContent from
 * @ctxlayer/shared, re-exported there as SkillContent).
 */

import { makeRevisionStore } from './revision-store'

export type { PutResult } from './revision-store'

const store = makeRevisionStore('skills')

export const writeRevisionAndSnapshot = store.writeRevisionAndSnapshot
export const contentDigest = store.contentDigest
export const readSnapshot = store.readSnapshot
export const deleteRevisionObjects = store.deleteRevisionObjects
export const readRevision = store.readRevision
export const restoreFromRevision = store.restoreFromRevision
