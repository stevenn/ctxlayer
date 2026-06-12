import { z } from 'zod'
import { UserSummary, DocContent } from './docs-types'
import { prefixedSlug } from './slug'

// SKILL.md-safe identifier. Lowercase, digits, internal hyphens; 1..64
// chars; must not start or end with '-'. Stricter than DocSlug (max 96)
// because Claude Code uses this verbatim as the SKILL.md `name:`
// frontmatter field and as the on-disk directory name under
// ~/.claude/skills/ctxlayer/<slug>/SKILL.md.
export const SkillSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase, digits and dashes only')
export type SkillSlug = z.infer<typeof SkillSlug>

// draft   — admin-only; invisible to list_skills / MCP / CLI export
// published — open-read to any signed-in user; surfaces via MCP + CLI
// archived — hidden from list_skills but kept for audit + un-archive
export const SkillStatus = z.enum(['draft', 'published', 'archived'])
export type SkillStatus = z.infer<typeof SkillStatus>

// One upstream-tool reference attached to a skill. tool_name empty
// string means the attachment is to the whole upstream (shows on
// the upstream's MCP row), not a specific tool.
export const SkillAttachmentRef = z.object({
  upstreamId: z.string(),
  upstreamSlug: z.string(),
  toolName: z.string()
})
export type SkillAttachmentRef = z.infer<typeof SkillAttachmentRef>

export const SkillTags = z.object({
  teams: z.array(z.string()),
  products: z.array(z.string()),
  topics: z.array(z.string())
})
export type SkillTags = z.infer<typeof SkillTags>

// Summary row for /api/skills (and admin/skills table). Mirrors
// DocSummary shape; no folder/lock fields (skills don't have those).
export const SkillSummary = z.object({
  id: z.string(),
  slug: SkillSlug,
  title: z.string(),
  description: z.string(),
  status: SkillStatus,
  createdAt: z.number(),
  updatedAt: z.number(),
  createdBy: UserSummary.nullish(),
  updatedBy: UserSummary.nullish(),
  // Reserved for M8: true when an attached upstream tool's schema
  // changed after this skill's updated_at. M7a always emits false;
  // M8 wires the join.
  isStale: z.boolean().optional()
})
export type SkillSummary = z.infer<typeof SkillSummary>

export const SkillDetail = SkillSummary.extend({
  triggerText: z.string(),
  currentRevId: z.string().nullish(),
  attachments: z.array(SkillAttachmentRef),
  tags: SkillTags,
  // M8: opaque JSON blob set by the drafting flow (CLI's draft-skill
  // command). Null for manually-authored skills. Shape validated via
  // DrafterMeta in draft-context-types.ts when the SPA reads it.
  drafterMeta: z.unknown().nullable()
})
export type SkillDetail = z.infer<typeof SkillDetail>

export const CreateSkillRequest = z.object({
  // If omitted, the server derives `sk-<slugified-title>` and appends a
  // suffix on collision (same algorithm as createDoc). If provided, must
  // carry the `sk-` prefix.
  slug: prefixedSlug('skill').optional(),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(500),
  triggerText: z.string().max(500).optional(),
  status: SkillStatus.optional(),
  // M8: opaque drafter metadata bag set by the CLI's draft-skill
  // command. Unparsed at the API boundary so additive fields don't
  // require schema bumps; the SPA validates shape on read.
  drafterMeta: z.unknown().optional(),
  // M8: BlockNote body to persist alongside the create (so the
  // drafting CLI doesn't need a follow-up PUT /content roundtrip).
  // If omitted, skill starts with an empty body.
  content: z.object({ blocks: z.array(z.unknown()) }).optional()
})
export type CreateSkillRequest = z.infer<typeof CreateSkillRequest>

export const UpdateSkillRequest = z.object({
  // Slug is immutable after creation: it's the public, agent-facing
  // identifier (MCP resource `mcp://ctxlayer/skills/{slug}`, get_skill
  // lookup, and the on-disk `<slug>/SKILL.md` from `ctxlayer pull`).
  // Renaming would orphan every one of those — so it's never patched.
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(500).optional(),
  triggerText: z.string().max(500).optional(),
  status: SkillStatus.optional()
})
export type UpdateSkillRequest = z.infer<typeof UpdateSkillRequest>

// Reuse DocContent shape — skill body is the same BlockNote block tree.
export { DocContent as SkillContent }

// CLI pull export. Each entry is everything the CLI needs to write a
// SKILL.md file. `name` is the SKILL.md frontmatter `name:` value
// (= ctxlayer slug); `description` is the SKILL.md `description:`.
// `bodyMd` is the body rendered to markdown server-side so the CLI
// doesn't need a BlockNote renderer.
export const SkillExportEntry = z.object({
  slug: SkillSlug,
  name: SkillSlug,
  description: z.string(),
  triggerText: z.string(),
  bodyMd: z.string()
})
export type SkillExportEntry = z.infer<typeof SkillExportEntry>

export const SkillExportResponse = z.object({
  skills: z.array(SkillExportEntry)
})
export type SkillExportResponse = z.infer<typeof SkillExportResponse>

// Same shape as a doc revision — alias the docs schema (both the value
// and the inferred type travel with this re-export).
export { RevisionSummary as SkillRevisionSummary } from './docs-types'

// M8: schema-reference linter finding. Server-side warning, never
// blocks save. SPA renders as a yellow strip above the editor.
export const SkillLintFinding = z.object({
  kind: z.enum(['unknown_upstream', 'unknown_tool']),
  reference: z.string(),
  upstreamSlug: z.string().nullable(),
  toolName: z.string().nullable()
})
export type SkillLintFinding = z.infer<typeof SkillLintFinding>

export const SkillContentSaveResult = z.object({
  revisionId: z.string(),
  byteSize: z.number(),
  contentHash: z.string(),
  lintFindings: z.array(SkillLintFinding)
})
export type SkillContentSaveResult = z.infer<typeof SkillContentSaveResult>
