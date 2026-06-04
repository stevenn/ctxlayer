/**
 * Per-tool ACL contracts — the "lock-down" layer that refines upstream
 * visibility. Semantics (design: docs/plan/J-tool-acl.md):
 *
 *   - A tool with ZERO rules inherits the upstream's visibility: anyone
 *     who can see the upstream can call it (today's behaviour).
 *   - A tool with ANY rule flips to allow-list: only principals named in
 *     a rule may call it; everyone else has it HIDDEN at tools/list time.
 *   - Rules are additive within the locked set (any match grants), and
 *     can only NARROW — they never grant a tool on an upstream the caller
 *     can't already see.
 *
 * Principals are groups only: `everyone`, `role`, `team`, `product`.
 * There is no per-user ACL by design.
 */
import { z } from 'zod'

export const ToolAccessPrincipalKind = z.enum(['everyone', 'role', 'team', 'product'])
export type ToolAccessPrincipalKind = z.infer<typeof ToolAccessPrincipalKind>

// One ACL rule. `principalId` is null for `everyone`, otherwise the
// role/team/product id.
export const ToolAccessRule = z.object({
  principalKind: ToolAccessPrincipalKind,
  principalId: z.string().nullable()
})
export type ToolAccessRule = z.infer<typeof ToolAccessRule>

// Replace the ENTIRE rule set for one tool on one upstream. An empty
// `rules` reverts the tool to inherit (open). The tool need not be in
// the live catalogue — locking ahead of a refresh is allowed.
export const ReplaceToolAccessRequest = z.object({
  toolName: z.string().min(1).max(256),
  rules: z.array(ToolAccessRule)
})
export type ReplaceToolAccessRequest = z.infer<typeof ReplaceToolAccessRequest>

// Admin read: one tool's ACL state. `orphaned` = the rule references a
// tool_name no longer present in the upstream's cached catalogue (an
// upstream rename strands the rule — it must be surfaced, never silently
// dropped, or the renamed tool would re-open).
export const ToolAccessEntry = z.object({
  toolName: z.string(),
  rules: z.array(ToolAccessRule),
  orphaned: z.boolean()
})
export type ToolAccessEntry = z.infer<typeof ToolAccessEntry>

export const UpstreamToolAccessResponse = z.object({
  upstreamId: z.string(),
  entries: z.array(ToolAccessEntry)
})
export type UpstreamToolAccessResponse = z.infer<typeof UpstreamToolAccessResponse>

// ----- pure evaluation core (shared by the proxy + the advisory) ---------

/** The caller's group memberships, resolved once per session. */
export interface UserPrincipals {
  roles: Set<string>
  teams: Set<string>
  products: Set<string>
}

/** A single ACL rule in its DB shape (principalId '' means everyone). */
export interface ToolAccessRuleLike {
  principalKind: ToolAccessPrincipalKind
  principalId: string
}

/**
 * Does the caller satisfy a tool's rule set? Zero/absent rules => true
 * (inherit). Otherwise any matching rule grants. This is the single
 * authority both the registration filter and the discoverability
 * advisory evaluate against, so they can never disagree.
 */
export function isToolAllowed(
  rules: ToolAccessRuleLike[] | undefined,
  p: UserPrincipals
): boolean {
  if (!rules || rules.length === 0) return true
  return rules.some(
    (r) =>
      r.principalKind === 'everyone' ||
      (r.principalKind === 'role' && p.roles.has(r.principalId)) ||
      (r.principalKind === 'team' && p.teams.has(r.principalId)) ||
      (r.principalKind === 'product' && p.products.has(r.principalId))
  )
}

/**
 * The principals that WOULD unlock a locked tool — surfaced to the user
 * via `list_my_context.restrictedTools` so they know what to request.
 * `everyone` rules collapse away (if present the tool isn't restricted
 * to the caller in the first place).
 */
export function requiresFromRules(rules: ToolAccessRuleLike[]): {
  roles: string[]
  teams: string[]
  products: string[]
} {
  const out = { roles: [] as string[], teams: [] as string[], products: [] as string[] }
  for (const r of rules) {
    if (r.principalKind === 'role') out.roles.push(r.principalId)
    else if (r.principalKind === 'team') out.teams.push(r.principalId)
    else if (r.principalKind === 'product') out.products.push(r.principalId)
  }
  return out
}
