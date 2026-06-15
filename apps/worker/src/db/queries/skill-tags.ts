/**
 * D1 queries for `skill_tags`. Mirrors `doc-tags.ts` shape and
 * semantics: tags filter `list_skills` default scope but do NOT gate
 * read access — every signed-in user can read every published skill.
 */

import type { Env } from '../../env'
import type { SkillTags } from '@ctxlayer/shared'

export type TagKind = 'team' | 'product' | 'tag'

interface TagRow {
  tag_kind: TagKind
  tag_value: string
}

export async function listTagsForSkill(env: Env, skillId: string): Promise<SkillTags> {
  const res = await env.DB.prepare(`SELECT tag_kind, tag_value FROM skill_tags WHERE skill_id = ?1`)
    .bind(skillId)
    .all<TagRow>()
  const out: SkillTags = { teams: [], products: [], tags: [] }
  for (const row of res.results ?? []) {
    if (row.tag_kind === 'team') out.teams.push(row.tag_value)
    else if (row.tag_kind === 'product') out.products.push(row.tag_value)
    else if (row.tag_kind === 'tag') out.tags.push(row.tag_value)
  }
  return out
}
