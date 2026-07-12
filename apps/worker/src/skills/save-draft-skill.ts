/**
 * Persist an agent-drafted skill as the author's PRIVATE draft. The
 * MCP-native replacement for the CLI's `POST /cli/skills` create path:
 * converts the markdown body to BlockNote blocks, creates the skill
 * (private + draft, owned by the caller), writes the first revision +
 * snapshot, lints (non-fatal), and audits. Called by the `save_draft_skill`
 * MCP tool (mcp/session-do.ts).
 */

import { SLUG_PREFIX, slugifyBody } from '@ctxlayer/shared'
import type { Env } from '../env'
import { createSkill, recordSkillRevision } from '../db/queries/skills'
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
}

export interface SaveDraftSkillResult {
  id: string
  slug: string
  lintFindings: LintFinding[]
}

export async function saveDraftSkill(
  env: Env,
  input: SaveDraftSkillInput
): Promise<SaveDraftSkillResult> {
  const content = { blocks: markdownToBlocks(input.body) }
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

  const revisionId = crypto.randomUUID().replace(/-/g, '')
  const put = await writeSkillRevisionAndSnapshot(env, row.id, revisionId, content)
  await recordSkillRevision(env, {
    skillId: row.id,
    revisionId,
    authorId: input.userId,
    r2Key: put.key,
    byteSize: put.byteSize,
    contentHash: put.contentHash
  })

  // Lint after persist — warning-only, never blocks the save.
  let lintFindings: LintFinding[] = []
  try {
    lintFindings = await lintSkillBody(env, row.id, content)
  } catch (err) {
    console.error('skill linter failed (non-fatal):', err)
  }

  await audit(env, {
    actorId: input.userId,
    action: 'skill.create',
    target: row.id,
    meta: { source: 'mcp', draftedBy: 'agent' }
  })

  return { id: row.id, slug: row.slug, lintFindings }
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
