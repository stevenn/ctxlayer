import { z } from 'zod'
import { prefixedSlug } from './slug'

export const TeamRef = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string().nullable().optional()
})
export type TeamRef = z.infer<typeof TeamRef>

export const ProductRef = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string().nullable().optional()
})
export type ProductRef = z.infer<typeof ProductRef>

export const TeamMemberRole = z.enum(['member', 'lead'])
export type TeamMemberRole = z.infer<typeof TeamMemberRole>

export const TeamMembership = TeamRef.extend({
  role: TeamMemberRole
})
export type TeamMembership = z.infer<typeof TeamMembership>

// NOTE: the `list_my_context` MCP output shape lives in `mcp-types.ts`
// (`McpMyContext`) — all-string-arrays, matching `resolveUserScope`. The
// earlier object-valued `MyContext` here had drifted from the live shape and
// was unused, so it was removed.

// Visibility rules on an upstream. Additive: any rule grants access.
export const VisibilityScopeKind = z.enum(['everyone', 'team', 'product'])
export const VisibilityRule = z.object({
  scopeKind: VisibilityScopeKind,
  scopeId: z.string().nullable()
})
export type VisibilityRule = z.infer<typeof VisibilityRule>

// Doc tags. Topic tag values are free-form slugs; team/product tag values
// reference the corresponding id columns.
export const DocTagKind = z.enum(['team', 'product', 'topic'])
export const DocTags = z.object({
  teams: z.array(z.string()),
  products: z.array(z.string()),
  topics: z.array(z.string())
})
export type DocTags = z.infer<typeof DocTags>

// search_docs scope argument.
export const SearchScope = z.union([
  z.literal('all'),
  z.object({
    teams: z.array(z.string()).optional(),
    products: z.array(z.string()).optional()
  })
])
export type SearchScope = z.infer<typeof SearchScope>

// ---- Admin CRUD request shapes ------------------------------------------
// Slug rules mirror docs-types.ts DocSlug: lowercase, digits, dashes;
// 1..96 chars; no leading/trailing dashes. Teams + products live in
// the same URL/tag namespace so they share the same shape.
export const OrgSlug = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase, digits and dashes only')

export const CreateTeamRequest = z.object({
  slug: prefixedSlug('team'),
  displayName: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  idpGroup: z.string().max(200).nullish(),
  // `true` reserves the team for IdP-sync ownership; sync logic itself
  // isn't shipped yet. Until then admins can still toggle this to mark
  // intent. See docs/plan/F-org-ia.md.
  managedByIdp: z.boolean().optional()
})
export type CreateTeamRequest = z.infer<typeof CreateTeamRequest>

export const UpdateTeamRequest = z.object({
  // Renamable, but a new slug must carry the `team-` prefix. The SPA only
  // sends `slug` when it actually changed, so editing other fields on a
  // grandfathered (pre-prefix) team doesn't force a re-slug.
  slug: prefixedSlug('team').optional(),
  displayName: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullish(),
  idpGroup: z.string().max(200).nullish(),
  managedByIdp: z.boolean().optional()
})
export type UpdateTeamRequest = z.infer<typeof UpdateTeamRequest>

// Admin-only enriched team row: `TeamRef` fields + IdP/group-sync prep.
// The user-facing `/api/teams` keeps returning `TeamRef[]` so IdP
// internals stay admin-scoped.
export const AdminTeamRow = TeamRef.extend({
  idpGroup: z.string().nullable(),
  managedByIdp: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type AdminTeamRow = z.infer<typeof AdminTeamRow>

export const CreateProductRequest = z.object({
  slug: prefixedSlug('product'),
  displayName: z.string().min(1).max(200),
  description: z.string().max(2000).nullish()
})
export type CreateProductRequest = z.infer<typeof CreateProductRequest>

export const UpdateProductRequest = z.object({
  // Renamable; a new slug must carry the `prod-` prefix. Same send-only-
  // when-changed rule as teams keeps grandfathered products editable.
  slug: prefixedSlug('product').optional(),
  displayName: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullish()
})
export type UpdateProductRequest = z.infer<typeof UpdateProductRequest>

export const AddTeamMemberRequest = z.object({
  userId: z.string().min(1),
  role: TeamMemberRole.optional()
})
export type AddTeamMemberRequest = z.infer<typeof AddTeamMemberRequest>

export const TeamMemberRow = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().nullish(),
  role: TeamMemberRole,
  createdAt: z.number()
})
export type TeamMemberRow = z.infer<typeof TeamMemberRow>

// teams ↔ products matrix — replace entire set in one PUT.
export const TeamProductsAssignment = z.object({
  teamId: z.string(),
  productId: z.string()
})
export type TeamProductsAssignment = z.infer<typeof TeamProductsAssignment>
export const TeamProductsPayload = z.object({
  rules: z.array(TeamProductsAssignment)
})
export type TeamProductsPayload = z.infer<typeof TeamProductsPayload>
