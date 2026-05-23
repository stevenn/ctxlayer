import { z } from 'zod'

export const DocKind = z.enum(['doc', 'prompt'])
export type DocKind = z.infer<typeof DocKind>

// Doc body is the BlockNote block tree (BlockNoteJSON). It's a recursive
// structure with content/props/children per block; pinning a strict shape
// here would couple us to a specific BlockNote version. We pass it
// through unchanged and let the editor be the source of truth. Size cap
// is enforced at the route level (CONTENT_MAX_BYTES).
export const DocContent = z.object({
  blocks: z.array(z.unknown())
})
export type DocContent = z.infer<typeof DocContent>

// Slug rules: lowercase letters, digits, and dashes; 1..96 chars; must
// not start or end with '-'. Matches what BlockNote produces from titles
// and what's safe in URLs / R2 keys.
export const DocSlug = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase, digits and dashes only')

export const DocSummary = z.object({
  id: z.string(),
  title: z.string(),
  slug: DocSlug,
  kind: DocKind,
  createdAt: z.number(),
  updatedAt: z.number(),
  createdBy: z.string().nullish()
})
export type DocSummary = z.infer<typeof DocSummary>

export const DocDetail = DocSummary.extend({
  currentRevId: z.string().nullish(),
  // Server-computed for the calling user. The SPA renders the editor
  // read-only when false; the Sharing button only appears when caller
  // is author or admin (a stricter property the server returns
  // separately so non-authors don't see it).
  canEdit: z.boolean(),
  canShare: z.boolean()
})
export type DocDetail = z.infer<typeof DocDetail>

export const CreateDocRequest = z.object({
  title: z.string().min(1).max(200),
  // If omitted, the server slugifies the title and appends a 6-char
  // suffix on collision.
  slug: DocSlug.optional(),
  kind: DocKind.optional()
})
export type CreateDocRequest = z.infer<typeof CreateDocRequest>

export const UpdateDocRequest = z.object({
  title: z.string().min(1).max(200).optional(),
  slug: DocSlug.optional(),
  kind: DocKind.optional()
})
export type UpdateDocRequest = z.infer<typeof UpdateDocRequest>

export const RevisionSummary = z.object({
  id: z.string(),
  authorId: z.string().nullish(),
  createdAt: z.number(),
  byteSize: z.number(),
  contentHash: z.string()
})
export type RevisionSummary = z.infer<typeof RevisionSummary>

export const DocEditorScope = z.enum(['user', 'everyone'])
export type DocEditorScope = z.infer<typeof DocEditorScope>

export const DocEditorUser = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().nullish()
})
export type DocEditorUser = z.infer<typeof DocEditorUser>

export const DocEditorsResponse = z.object({
  users: z.array(DocEditorUser),
  everyone: z.boolean()
})
export type DocEditorsResponse = z.infer<typeof DocEditorsResponse>

// Discriminated union so the server validates exactly one shape.
export const AddEditorRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string().min(1) }),
  z.object({ kind: z.literal('everyone') })
])
export type AddEditorRequest = z.infer<typeof AddEditorRequest>

export const UserSearchResult = z.array(
  z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullish()
  })
)
export type UserSearchResult = z.infer<typeof UserSearchResult>

export const RestoreRequest = z.object({
  revisionId: z.string().min(1)
})
export type RestoreRequest = z.infer<typeof RestoreRequest>
