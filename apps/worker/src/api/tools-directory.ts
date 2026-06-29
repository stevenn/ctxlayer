/**
 * Builder for the user-facing tools directory (`GET /api/tools` → `/app/tools`).
 *
 * Surfaces the org's built-in tools + every visible upstream's cached tools,
 * grouped by family (native names), from the catalogue cache (no upstream
 * dial). Unlike the agent-facing `describe_upstream` (which HIDES ACL-locked
 * tools), this SHOWS them with `restricted: true` + the role/team/product
 * DISPLAY NAMES that would unlock them — the same advisory stance as
 * `list_my_context.restrictedTools`. The route handler (`api/tools.ts`) stays
 * SQL-free and just calls `buildToolsDirectory`.
 */

import type { Env } from '../env'
import {
  BUILTIN_TOOLS,
  isToolAllowed,
  requiresFromRules,
  type ToolsDirectory,
  type ToolsDirectoryGroup,
  type ToolsDirectoryTool,
  type UserPrincipals
} from '@ctxlayer/shared'
import { listUpstreamsVisibleToUser } from '../db/queries/upstreams'
import { listCachedToolsForUpstreams, type UpstreamToolRow } from '../db/queries/upstream-tools'
import {
  accessKey,
  indexToolAccess,
  listToolAccessForUpstreams
} from '../db/queries/tool-access'
import { resolveUserScope } from '../db/queries/doc-tags'
import { listRoles, listUserRoleIds } from '../db/queries/roles'
import { listTeams } from '../db/queries/teams'
import { listProducts } from '../db/queries/products'
import { mangleToolName, toolFamily } from '../mcp/tool-name'
import { summariseToolDescription, UpstreamProxyRegistry } from '../mcp/tools-proxy'

/** Principal id → display name, per kind, for resolving the "requires" badge. */
export interface NameMaps {
  roles: Map<string, string>
  teams: Map<string, string>
  products: Map<string, string>
}

/** Map the unlocking principal IDs to display names, falling back to the raw
 *  id when a principal was deleted (orphaned ACL rule). */
export function resolveRequiresNames(
  requires: { roles: string[]; teams: string[]; products: string[] },
  names: NameMaps
): { roles: string[]; teams: string[]; products: string[] } {
  return {
    roles: requires.roles.map((id) => names.roles.get(id) ?? id),
    teams: requires.teams.map((id) => names.teams.get(id) ?? id),
    products: requires.products.map((id) => names.products.get(id) ?? id)
  }
}

/**
 * Group one upstream's cached tools by family, annotating each with its
 * callable name, one-line summary, and ACL-restricted state (+ the display
 * names that would unlock a locked tool). Pure — same family/sort rule as
 * `groupToolsByFamily`, but SHOWS locked tools instead of hiding them.
 */
export function groupDirectoryTools(
  upstreamId: string,
  slug: string,
  tools: UpstreamToolRow[],
  acl: ReturnType<typeof indexToolAccess>,
  principals: UserPrincipals,
  names: NameMaps
): ToolsDirectoryGroup[] {
  const byFamily = new Map<string, ToolsDirectoryTool[]>()
  for (const t of tools) {
    const family = toolFamily(slug, t.tool_name)
    const rules = acl.get(accessKey(upstreamId, t.tool_name))
    const restricted = rules && rules.length > 0 ? !isToolAllowed(rules, principals) : false
    const entry: ToolsDirectoryTool = {
      name: t.tool_name,
      call: mangleToolName(slug, t.tool_name),
      summary: summariseToolDescription(t.description),
      restricted,
      ...(restricted && rules
        ? { requires: resolveRequiresNames(requiresFromRules(rules), names) }
        : {})
    }
    const arr = byFamily.get(family)
    if (arr) arr.push(entry)
    else byFamily.set(family, [entry])
  }
  return [...byFamily.entries()]
    .sort(([a], [b]) => {
      // Ungrouped ('') always last; otherwise alphabetical.
      if (a === '') return 1
      if (b === '') return -1
      return a < b ? -1 : a > b ? 1 : 0
    })
    .map(([family, entries]) => ({
      family,
      tools: entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    }))
}

/**
 * Assemble the full directory for one user: built-ins + every visible
 * upstream (with connection state from `listUpstreamsForUser`) and its
 * family-grouped tools. Empty-cache upstreams are listed with `groups: []`.
 */
export async function buildToolsDirectory(env: Env, userId: string): Promise<ToolsDirectory> {
  const [scope, roleIds] = await Promise.all([
    resolveUserScope(env, userId),
    listUserRoleIds(env, userId)
  ])
  const principals: UserPrincipals = {
    teams: new Set(scope.teams),
    products: new Set(scope.products),
    roles: new Set(roleIds)
  }

  // Headers (connection state + raw toolsCount + attachments) come from the
  // same builder `list_upstreams` uses; the visible rows give us id↔slug for
  // the catalogue/ACL reads (the header carries no internal id by design).
  const [headers, rows, roles, teams, products] = await Promise.all([
    UpstreamProxyRegistry.listUpstreamsForUser(env, userId),
    listUpstreamsVisibleToUser(env, userId),
    listRoles(env),
    listTeams(env),
    listProducts(env)
  ])
  const ids = rows.map((r) => r.id)
  const [cachedByUpstream, aclRows] = await Promise.all([
    listCachedToolsForUpstreams(env, ids),
    listToolAccessForUpstreams(env, ids)
  ])
  const acl = indexToolAccess(aclRows)
  const names: NameMaps = {
    roles: new Map(roles.map((r) => [r.id, r.displayName])),
    teams: new Map(teams.map((t) => [t.id, t.displayName])),
    products: new Map(products.map((p) => [p.id, p.displayName]))
  }
  const idBySlug = new Map(rows.map((r) => [r.slug, r.id]))

  let totalRows = 0
  const upstreams = headers.map((h) => {
    const id = idBySlug.get(h.slug)
    const tools = id ? (cachedByUpstream.get(id) ?? []) : []
    totalRows += tools.length
    return {
      ...h,
      id: id ?? '',
      groups: id ? groupDirectoryTools(id, h.slug, tools, acl, principals, names) : []
    }
  })
  if (totalRows > 2000) {
    console.warn(`[tools-directory] ${totalRows} cached tool rows for ${userId} — consider pagination`)
  }
  return { builtins: BUILTIN_TOOLS, upstreams }
}
