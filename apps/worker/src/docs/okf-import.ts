/**
 * Project parsed OKF frontmatter onto a doc — the import-side inverse of
 * okf.ts. Shared by git sync and bundle import. Well-known scalar fields + the
 * preserved raw block land via one patch (clamped to DOC_LIMITS); `tags` become
 * additive free-form tags. A plain (no-frontmatter) file clears the OKF columns
 * and leaves okf_frontmatter null so write-back/export stay frontmatter-free.
 */

import { DOC_LIMITS, type OkfKnownFields, clampText } from '@ctxlayer/shared'
import type { Env } from '../env'
import { patchDoc } from '../db/queries/docs'
import { addDocTags } from '../db/queries/doc-tags'

export async function applyOkfMetadata(
  env: Env,
  docId: string,
  known: OkfKnownFields,
  raw: string | null
): Promise<void> {
  await patchDoc(env, docId, {
    docType: known.type ? clampText(known.type, DOC_LIMITS.type) : null,
    description: known.description ? clampText(known.description, DOC_LIMITS.description) : null,
    resource: known.resource ? clampText(known.resource, DOC_LIMITS.resource) : null,
    okfFrontmatter: raw && raw.length <= DOC_LIMITS.frontmatter ? raw : null
  })
  if (known.tags?.length) await addDocTags(env, docId, known.tags)
}
