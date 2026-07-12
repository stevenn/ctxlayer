/**
 * Persist an agent-drafted skill — the tool behind the `save_draft_skill`
 * MCP tool (mcp/session-do.ts). UPSERT semantics so iterating a skill
 * versions ONE artifact instead of spawning duplicates:
 *   - `skillId` given, or a `slug` that matches one of the caller's own
 *     skills → UPDATE it in place (a new revision + refreshed metadata),
 *     reusing the existing skill_revisions history (restorable in the editor).
 *   - otherwise → CREATE a new private draft.
 * Updates are owner-scoped and non-destructive (prior body stays a revision).
 * A published skill can be updated too — the edit is LIVE to the org, same as
 * editing it in the SPA — so the result flags `created`/`status` for a clear
 * "this went live" message.
 */

import { SLUG_PREFIX, slugifyBody } from '@ctxlayer/shared'
import type { Env } from '../env'
import {
  createSkill,
  getSkillById,
  getSkillBySlug,
  listSkillRevisions,
  patchSkill,
  recordSkillRevision,
  type SkillWithUsersRow
} from '../db/queries/skills'
import { writeRevisionAndSnapshot as writeSkillRevisionAndSnapshot } from '../storage/skills-r2'
import { lintSkillBody, type LintFinding } from './schema-linter'
import { markdownToBlocks } from './markdown-to-blocks'
import { DRAFTER_PROMPT_VERSION } from './drafter-prompt'
import { audit } from '../audit/log'

export interface SaveDraftSkillInput {
  userId: string
  title: string
  description: string
  /** Skill body as markdown (converted to BlockNote blocks server-side). */
  body: string
  slug?: string
  triggerText?: string
  /** Upstream slugs the skill was drafted against — recorded in drafter_meta
   *  so consumers are warned when they can't reach one (see skill-requires). */
  upstreams?: string[]
  /** Target an existing skill to UPDATE in place (a new version) instead of
   *  creating a duplicate. When omitted, a `slug` that matches one of the
   *  caller's own skills upserts into it. */
  skillId?: string
}

export interface SaveDraftSkillResult {
  id: string
  slug: string
  lintFindings: LintFinding[]
  /** false when an existing skill was updated in place. */
  created: boolean
  /** The (unchanged) status of the skill written to. 'published' means the
   *  edit is live to the org. */
  status: 'draft' | 'published' | 'archived'
  /** Total revisions after this save — i.e. the version number. */
  version: number
}

/** Thrown when an explicit `skillId` upsert target is missing or not owned. */
export class SaveDraftSkillError extends Error {
  constructor(public code: 'skill_not_found' | 'not_owner') {
    super(code)
  }
}

/** The body shape the revision writer + linter accept (blocks from markdown). */
type SkillContent = { blocks: ReturnType<typeof markdownToBlocks> }

export async function saveDraftSkill(
  env: Env,
  input: SaveDraftSkillInput
): Promise<SaveDraftSkillResult> {
  const content: SkillContent = { blocks: markdownToBlocks(input.body) }
  const target = await resolveUpsertTarget(env, input)
  return target
    ? updateExistingSkill(env, input, target, content)
    : createDraftSkill(env, input, content)
}

/**
 * The caller-owned skill to update, or null to create. `skillId` is explicit
 * (owner-checked, throws on miss/foreign); otherwise a supplied `slug` that
 * resolves to one of the caller's own skills upserts into it. Both keep the
 * tool owner-scoped — it can never mutate someone else's skill.
 */
async function resolveUpsertTarget(
  env: Env,
  input: SaveDraftSkillInput
): Promise<SkillWithUsersRow | null> {
  if (input.skillId) {
    const row = await getSkillById(env, input.skillId)
    if (!row) throw new SaveDraftSkillError('skill_not_found')
    if (row.created_by !== input.userId) throw new SaveDraftSkillError('not_owner')
    return row
  }
  if (input.slug) {
    const row = await getSkillBySlug(env, normalizeSkillSlug(input.slug))
    if (row && row.created_by === input.userId) return row
  }
  return null
}

async function updateExistingSkill(
  env: Env,
  input: SaveDraftSkillInput,
  target: SkillWithUsersRow,
  content: SkillContent
): Promise<SaveDraftSkillResult> {
  // Refresh identity; status/visibility are deliberately untouched (a
  // published skill stays live — editing its body is the live edit, same as
  // the SPA). drafter_meta is left as the original provenance.
  await patchSkill(env, target.id, {
    title: input.title,
    description: input.description,
    triggerText: input.triggerText
  })
  await writeRevision(env, target.id, input.userId, content)
  const lintFindings = await lintQuietly(env, target.id, content)
  await audit(env, {
    actorId: input.userId,
    action: 'skill.update',
    target: target.id,
    meta: { source: 'mcp', draftedBy: 'agent' }
  })
  const version = (await listSkillRevisions(env, target.id)).length
  return { id: target.id, slug: target.slug, lintFindings, created: false, status: target.status, version }
}

async function createDraftSkill(
  env: Env,
  input: SaveDraftSkillInput,
  content: SkillContent
): Promise<SaveDraftSkillResult> {
  const row = await createSkill(env, {
    slug: input.slug ? normalizeSkillSlug(input.slug) : undefined,
    title: input.title,
    description: input.description,
    triggerText: input.triggerText,
    status: 'draft',
    visibility: 'private',
    drafterMeta: {
      from: 'mcp+agent',
      promptVersion: DRAFTER_PROMPT_VERSION,
      draftedAt: Math.floor(Date.now() / 1000),
      ...(input.upstreams && input.upstreams.length > 0 ? { upstreams: input.upstreams } : {})
    },
    createdBy: input.userId
  })
  await writeRevision(env, row.id, input.userId, content)
  const lintFindings = await lintQuietly(env, row.id, content)
  await audit(env, {
    actorId: input.userId,
    action: 'skill.create',
    target: row.id,
    meta: { source: 'mcp', draftedBy: 'agent' }
  })
  return { id: row.id, slug: row.slug, lintFindings, created: true, status: 'draft', version: 1 }
}

async function writeRevision(
  env: Env,
  skillId: string,
  authorId: string,
  content: SkillContent
): Promise<void> {
  const revisionId = crypto.randomUUID().replace(/-/g, '')
  const put = await writeSkillRevisionAndSnapshot(env, skillId, revisionId, content)
  await recordSkillRevision(env, {
    skillId,
    revisionId,
    authorId,
    r2Key: put.key,
    byteSize: put.byteSize,
    contentHash: put.contentHash
  })
}

/** Lint after persist — warning-only, never blocks or throws the save. */
async function lintQuietly(
  env: Env,
  skillId: string,
  content: SkillContent
): Promise<LintFinding[]> {
  try {
    return await lintSkillBody(env, skillId, content)
  } catch (err) {
    console.error('skill linter failed (non-fatal):', err)
    return []
  }
}

/**
 * Coerce an agent-supplied slug to the enforced `sk-<body>` shape (the same
 * normalisation the CLI applied): strip any existing prefix so we don't
 * double it, re-slugify the body, then re-prefix and cap at the SkillSlug
 * max. Omit `slug` entirely to let `createSkill` derive `sk-<title>`.
 */
function normalizeSkillSlug(raw: string): string {
  const prefix = `${SLUG_PREFIX.skill}-`
  const body = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
  return `${prefix}${slugifyBody(body, 64 - prefix.length)}`
}
