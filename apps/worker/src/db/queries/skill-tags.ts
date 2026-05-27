/**
 * D1 queries for `skill_tags`. Mirrors `doc-tags.ts` shape and
 * semantics: tags filter `list_skills` default scope but do NOT gate
 * read access — every signed-in user can read every published skill.
 */

import type { Env } from '../../env'
import type { SkillTags } from '@ctxlayer/shared'

export type TagKind = 'team' | 'product' | 'topic'

interface TagRow {
  tag_kind: TagKind
  tag_value: string
}

export async function listTagsForSkill(env: Env, skillId: string): Promise<SkillTags> {
  const res = await env.DB.prepare(
    `SELECT tag_kind, tag_value FROM skill_tags WHERE skill_id = ?1`
  )
    .bind(skillId)
    .all<TagRow>()
  const out: SkillTags = { teams: [], products: [], topics: [] }
  for (const row of res.results ?? []) {
    if (row.tag_kind === 'team') out.teams.push(row.tag_value)
    else if (row.tag_kind === 'product') out.products.push(row.tag_value)
    else if (row.tag_kind === 'topic') out.topics.push(row.tag_value)
  }
  return out
}

/**
 * Replace all tags for a skill. Single batch (delete + per-tag insert)
 * so the table is never partially updated. Caller has validated
 * (admin + skill exists).
 */
export async function replaceTagsForSkill(
  env: Env,
  skillId: string,
  tags: SkillTags
): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM skill_tags WHERE skill_id = ?1`).bind(skillId)
  ]
  for (const teamId of tags.teams) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO skill_tags (skill_id, tag_kind, tag_value) VALUES (?1, 'team', ?2)`
      ).bind(skillId, teamId)
    )
  }
  for (const productId of tags.products) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO skill_tags (skill_id, tag_kind, tag_value) VALUES (?1, 'product', ?2)`
      ).bind(skillId, productId)
    )
  }
  for (const topic of tags.topics) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO skill_tags (skill_id, tag_kind, tag_value) VALUES (?1, 'topic', ?2)`
      ).bind(skillId, topic)
    )
  }
  await env.DB.batch(stmts)
}
