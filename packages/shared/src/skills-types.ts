import { z } from 'zod'
import { UserSummary, DocContent } from './docs-types'

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
  tags: SkillTags
})
export type SkillDetail = z.infer<typeof SkillDetail>

export const CreateSkillRequest = z.object({
  // If omitted, the server slugifies the title and appends a suffix
  // on collision (same algorithm as createDoc).
  slug: SkillSlug.optional(),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(500),
  triggerText: z.string().max(500).optional(),
  status: SkillStatus.optional()
})
export type CreateSkillRequest = z.infer<typeof CreateSkillRequest>

export const UpdateSkillRequest = z.object({
  slug: SkillSlug.optional(),
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

export const SkillRevisionSummary = z.object({
  id: z.string(),
  authorId: z.string().nullish(),
  createdAt: z.number(),
  byteSize: z.number(),
  contentHash: z.string()
})
export type SkillRevisionSummary = z.infer<typeof SkillRevisionSummary>
