import { z } from 'zod'

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

// `list_my_context()` result + GET /api/me/context body.
export const MyContext = z.object({
  teams: z.array(TeamMembership),
  products: z.array(ProductRef),
  accessibleUpstreams: z.array(z.string()),
  defaultScope: z.object({
    teams: z.array(z.string()),
    products: z.array(z.string())
  })
})
export type MyContext = z.infer<typeof MyContext>

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
