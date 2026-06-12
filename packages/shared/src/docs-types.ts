import { z } from 'zod'
import { prefixedSlug } from './slug'

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

// Folder path. `null` = root. Otherwise an absolute path like
// `/specs/api/v2`. Segments are slug-shaped (lowercase letters, digits,
// dashes). Max depth 5 keeps the tree sidebar usable; max total 200
// chars matches reasonable filesystem-ish paths and stops anyone storing
// arbitrary blobs in the column.
const FolderSegment = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const FolderPath = z
  .string()
  .min(2)
  .max(200)
  .refine(
    (s) => {
      if (!s.startsWith('/')) return false
      if (s.endsWith('/')) return false
      const segs = s.slice(1).split('/')
      if (segs.length > 5) return false
      return segs.every((seg) => FolderSegment.test(seg))
    },
    {
      message: 'leading "/", slug-shaped segments separated by "/", max depth 5, no trailing "/"'
    }
  )
export type FolderPath = z.infer<typeof FolderPath>

// Compact user shape for "created by" / "last edited by" attributions.
// `null` when the underlying user row was deleted out from under the
// doc (FK is informational in D1; rows may dangle).
export const UserSummary = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullish()
})
export type UserSummary = z.infer<typeof UserSummary>

export const DocSummary = z.object({
  id: z.string(),
  title: z.string(),
  slug: DocSlug,
  kind: DocKind,
  // Folder path or null (= root). See FolderPath above for the format.
  folder: FolderPath.nullable(),
  // The git source this doc is synced from, or null for authored docs.
  // Drives the Home vs Code Docs split + the git badge in the library.
  gitSourceId: z.string().nullable(),
  // Human-readable identity of that git source, joined in for the library
  // UI: the Code Docs tree groups synced docs under a virtual per-repo
  // node labelled with the source. Both null for authored docs (and for a
  // git doc whose source row was removed).
  gitSourceSlug: z.string().nullable(),
  gitSourceName: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  // The original author (documents.created_by joined to users).
  createdBy: UserSummary.nullish(),
  // The author of the most recent revision (documents.current_rev_id
  // → doc_revisions.author_id → users). Null for freshly-created docs
  // that have no revisions yet.
  updatedBy: UserSummary.nullish(),
  // Lock state. `lockedAt` is the unix timestamp the lock was
  // applied; `lockedBy` is the user who applied it. Both null when
  // the doc is unlocked (the normal case).
  lockedAt: z.number().nullable(),
  lockedBy: UserSummary.nullable()
})
export type DocSummary = z.infer<typeof DocSummary>

export const DocDetail = DocSummary.extend({
  currentRevId: z.string().nullish(),
  // Server-computed for the calling user. The SPA renders the editor
  // read-only when false; the Sharing button only appears when caller
  // is author or admin (a stricter property the server returns
  // separately so non-authors don't see it).
  //
  // `canEdit` already reflects the lock: a locked doc returns false
  // for everyone (incl. admin + creator) per the no-bypass design.
  // The SPA still shows the lock toggle when `canLock` is true.
  canEdit: z.boolean(),
  canShare: z.boolean(),
  canLock: z.boolean()
})
export type DocDetail = z.infer<typeof DocDetail>

// PUT /api/docs/:id/lock body. `locked: true` applies a lock (server
// fills in the actor + timestamp); `locked: false` releases it.
export const SetLockedRequest = z.object({
  locked: z.boolean()
})
export type SetLockedRequest = z.infer<typeof SetLockedRequest>

export const CreateDocRequest = z.object({
  title: z.string().min(1).max(200),
  // If omitted, the server derives `doc-<slugified-title>` and appends a
  // 6-char suffix on collision. If provided, must carry the `doc-` prefix.
  slug: prefixedSlug('doc').optional(),
  kind: DocKind.optional(),
  // Folder path. Omit or pass null to create at root.
  folder: FolderPath.nullable().optional()
})
export type CreateDocRequest = z.infer<typeof CreateDocRequest>

export const UpdateDocRequest = z.object({
  title: z.string().min(1).max(200).optional(),
  // Slug is immutable after creation: it's a stable reference (get_doc
  // accepts id-or-slug, search deep-links, doc-link hrefs), so renaming
  // it would silently orphan those. Set once at create; never patched.
  kind: DocKind.optional(),
  // Pass `null` to move to root, a FolderPath to move, or omit to leave
  // the folder unchanged. `.nullable()` admits null; `.optional()` admits
  // omission — together they distinguish "set to null" from "no change".
  folder: FolderPath.nullable().optional()
})
export type UpdateDocRequest = z.infer<typeof UpdateDocRequest>

// ----- Folder tree + ops --------------------------------------------------

// `path` is the absolute folder path (e.g. '/specs/api'). `docCount`
// counts docs whose folder == this exact path (not descendants).
// `descendantDocCount` counts docs whose folder == this path OR starts
// with `${path}/`. The SPA uses descendantDocCount for "delete folder"
// confirmation copy.
export const FolderTreeNode = z.object({
  path: FolderPath,
  docCount: z.number().int().min(0),
  descendantDocCount: z.number().int().min(0)
})
export type FolderTreeNode = z.infer<typeof FolderTreeNode>

export const FolderTreeResponse = z.object({
  folders: z.array(FolderTreeNode)
})
export type FolderTreeResponse = z.infer<typeof FolderTreeResponse>

// Rename / move folder: every doc whose folder == oldPath OR starts
// with `${oldPath}/` gets re-pathed under newPath. Server-side validates
// that the caller can edit ALL affected docs (returns 403 with a list of
// blocking doc ids if not).
export const FolderRenameRequest = z.object({
  oldPath: FolderPath,
  newPath: FolderPath
})
export type FolderRenameRequest = z.infer<typeof FolderRenameRequest>

export const RevisionSummary = z.object({
  id: z.string(),
  authorId: z.string().nullish(),
  createdAt: z.number(),
  byteSize: z.number(),
  contentHash: z.string(),
  // 'autosave' = a coalescing rolling checkpoint; 'explicit' = a user Save
  // (or restore). Defaulted for forward-compat with pre-coalescing rows.
  kind: z.enum(['autosave', 'explicit']).default('explicit')
})
export type RevisionSummary = z.infer<typeof RevisionSummary>

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
