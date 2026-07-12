/**
 * A skill's upstream dependencies — "which upstreams does this skill need,
 * and can the caller reach them?" — surfaced so an agent never follows a
 * playbook whose tools it can't call. Sources (caller-independent):
 *   - the skill's ATTACHMENTS (admin-declared "this skill is for these
 *     upstreams"), and
 *   - the upstreams it was AI-DRAFTED against (recorded in drafter_meta by
 *     save_draft_skill) — the only reliable signal for user-drafted skills,
 *     whose bodies use native tool names that don't carry a slug.
 * The caller-scoped `missing` set is the intersection's job, not the
 * requirement's.
 */

import type { Env } from '../env'
import { getSkillBySlug } from '../db/queries/skills'
import { listAttachmentsForSkill } from '../db/queries/skill-attachments'
import { listUpstreamsVisibleToUser } from '../db/queries/upstreams'

/**
 * Parse the `upstreams: string[]` hint an AI-drafted skill stored in its
 * opaque `drafter_meta` (the slugs the `/draft-skill` prompt drafted
 * against). Tolerant — returns [] on missing/malformed data.
 */
export function draftedForUpstreams(drafterMetaJson: string | null): string[] {
  if (!drafterMetaJson) return []
  try {
    const m = JSON.parse(drafterMetaJson) as { upstreams?: unknown }
    return Array.isArray(m.upstreams)
      ? m.upstreams.filter((s): s is string => typeof s === 'string')
      : []
  } catch {
    return []
  }
}

/** Distinct upstream slugs a skill depends on. Caller-independent. */
export function requiredUpstreamSlugs(
  attachmentSlugs: string[],
  draftedForSlugs: string[]
): string[] {
  return [...new Set([...attachmentSlugs, ...draftedForSlugs])]
}

/** The subset of `required` the caller can't currently reach. */
export function missingUpstreams(required: string[], visibleSlugs: Set<string>): string[] {
  return required.filter((s) => !visibleSlugs.has(s))
}

/**
 * Agent-facing access advisory for `get_skill`: a short markdown footer
 * naming the required upstreams the CALLER can't reach, or '' when the
 * caller can reach everything (or nothing is required / no caller id).
 * Reads attachments + the drafted-against hint only (no body/R2 read).
 */
export async function skillAccessAdvisory(
  env: Env,
  userId: string | undefined,
  slug: string
): Promise<string> {
  if (!userId) return ''
  const row = await getSkillBySlug(env, slug)
  if (!row) return ''
  const [attachments, visibleRows] = await Promise.all([
    listAttachmentsForSkill(env, row.id),
    listUpstreamsVisibleToUser(env, userId)
  ])
  const required = requiredUpstreamSlugs(
    attachments.map((a) => a.upstream_slug),
    draftedForUpstreams(row.drafter_meta)
  )
  const missing = missingUpstreams(required, new Set(visibleRows.map((u) => u.slug)))
  if (missing.length === 0) return ''
  const list = missing.map((s) => `\`${s}\``).join(', ')
  const verb = missing.length > 1 ? 'are' : 'is'
  const them = missing.length > 1 ? 'them' : 'it'
  return (
    `\n\n---\n> ⚠ **Access note:** this skill uses ${list}, which ${verb} not available to you ` +
    `right now. Connect ${them} in /app/upstreams (or ask an admin for access) before following these steps.`
  )
}
