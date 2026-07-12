/**
 * Central authorization predicates for skills — the single source of
 * truth for who may read and who may write a skill. Pure functions (no
 * DB, no request context) so they're shared unchanged by the REST routes
 * (api/skills.ts) and the MCP surfaces once those thread the caller id
 * through.
 *
 * Two orthogonal axes plus ownership collapse into one read gate:
 *   readable = admin
 *           OR owner (created_by === caller)
 *           OR (visibility === 'org' AND status === 'published').
 * Write is owner-or-admin. Attaching a skill to an upstream is a
 * separate, stricter admin-only action (it fans the skill onto every
 * tool description) and is NOT governed here — see api/skill-attachments.ts.
 */

import type { SkillWithUsersRow } from '../db/queries/skills'

type ReadFields = Pick<SkillWithUsersRow, 'created_by' | 'visibility' | 'status'>
type OwnerFields = Pick<SkillWithUsersRow, 'created_by'>

export function canReadSkill(row: ReadFields, userId: string | null, role: string): boolean {
  if (role === 'admin') return true
  if (userId != null && row.created_by === userId) return true
  return row.visibility === 'org' && row.status === 'published'
}

export function canWriteSkill(row: OwnerFields, userId: string | null, role: string): boolean {
  if (role === 'admin') return true
  return userId != null && row.created_by === userId
}
