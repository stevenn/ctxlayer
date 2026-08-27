/**
 * Read-models over the cached upstream catalogue for the discovery
 * built-ins — `describe_upstream`, `list_upstreams`,
 * `list_my_context.restrictedTools` — plus the server-instructions
 * guidance tail and the pure description/grouping helpers they share
 * with tool registration (`proxy-registry.ts`). Cache-only: nothing
 * here dials an upstream.
 */

import type { Env } from '../env'
import {
  getUpstreamVisibleToUser,
  listUpstreamsVisibleToUser,
  type UpstreamServerRow
} from '../db/queries/upstreams'
import {
  countToolsForUpstreams,
  listCachedTools,
  listCachedToolsForUpstreams,
  type UpstreamToolRow
} from '../db/queries/upstream-tools'
import { getUserCredentialStatuses } from '../db/queries/upstream-credentials'
import {
  listSkillsForUpstream,
  listSkillsForUpstreams,
  type SkillForUpstreamRow
} from '../db/queries/skill-attachments'
import {
  listDocsForUpstream,
  listDocsForUpstreams,
  type DocForUpstreamRow
} from '../db/queries/doc-attachments'
import {
  accessKey,
  indexToolAccess,
  listToolAccessForUpstream,
  listToolAccessForUpstreams,
  resolveUserPrincipals
} from '../db/queries/tool-access'
import { isDialableTransport } from '../upstream/upstream-client'
import {
  isToolAllowed,
  requiresFromRules,
  type McpAttachedDocRef,
  type McpAttachedSkillRef,
  type McpRestrictedTool,
  type McpUpstreamEntry,
  type McpUpstreamToolGroup,
  type McpUpstreamTools,
  type SupportedTransport,
  type UserPrincipals
} from '@ctxlayer/shared'
import { mangleToolName, toolFamily } from './tool-name'
import { sanitizeUntrustedText } from './provenance'

// The `list_upstreams` entry shape is the shared MCP output contract; the
// builder below is typed against it so it can't drift from the schema.
export type ListUpstreamsEntry = McpUpstreamEntry

/**
 * The visible-upstream rows + their skill/doc attachments for one user,
 * fetched in 3 round trips total (one list + two `IN (...)` batches).
 * Loaded once per session init and shared between `upstreamGuidance`
 * (server instructions) and registry `init` (tool registration) so
 * neither re-runs the visibility query or the per-upstream attachment
 * reads.
 */
export interface UpstreamUserContext {
  rows: UpstreamServerRow[]
  skillsByUpstream: Map<string, SkillForUpstreamRow[]>
  docsByUpstream: Map<string, DocForUpstreamRow[]>
}

/**
 * The visible upstreams + their attachments for one user, in 3 D1
 * round trips. `McpSessionDO.init()` loads this once and feeds it to
 * both `upstreamGuidance` and the registry's `init`.
 */
export async function loadUserContext(env: Env, userId: string): Promise<UpstreamUserContext> {
  const rows = await listUpstreamsVisibleToUser(env, userId)
  const ids = rows.map((r) => r.id)
  const [skillsByUpstream, docsByUpstream] = await Promise.all([
    listSkillsForUpstreams(env, ids),
    listDocsForUpstreams(env, ids)
  ])
  return { rows, skillsByUpstream, docsByUpstream }
}

const GUIDANCE_HEADER =
  '**Org playbooks for your upstreams — read the named skill/doc BEFORE the ' +
  'first call to that upstream (fetch via `get_skill` / `get_doc`; required ' +
  'conventions the tool schemas do not show):**\n'

/** Refs named per upstream line before collapsing into `+N more`. */
const MAX_REFS_PER_LINE = 3

/**
 * Builds the LEADING block of the MCP server `instructions`: one line
 * per visible upstream that carries a *whole-upstream* skill/doc
 * attachment (tool_name = ''), naming each so the agent reads the org
 * playbook before its first call. Returns '' when nothing is attached;
 * otherwise ends with a blank line so the static base reads on from it.
 * It goes FIRST because clients truncate long instructions and a
 * trailing tail is exactly what gets cut — see the size-budget note in
 * server-instructions.ts.
 *
 * `budget` (chars, normally GUIDANCE_BUDGET) bounds the block for ANY
 * attachment count: refs collapse to `+N more` past MAX_REFS_PER_LINE,
 * and when whole lines no longer fit the rest degrade to one pointer at
 * `list_upstreams.attached_skills` — the structured second step — so
 * growth can never push the static base past the client cap. Which
 * upstreams get named under collapse is row order (the visibility-query
 * order); nothing smarter until a real org hits it.
 * The slugs are org-curated (kebab-case, first-party) — unlike upstream
 * tool descriptions they are not untrusted input, so no sanitisation.
 * Pure formatting over the prefetched `loadUserContext` data.
 */
export function upstreamGuidance(ctx: UpstreamUserContext, budget: number): string {
  const lines: string[] = []
  for (const row of ctx.rows) {
    const refs = wholeUpstreamPointers(
      ctx.skillsByUpstream.get(row.id) ?? [],
      ctx.docsByUpstream.get(row.id) ?? []
    )
    if (refs.length === 0) continue
    const named = refs.slice(0, MAX_REFS_PER_LINE)
    const extra = refs.length - named.length
    lines.push(`- \`${row.slug}\`: ${named.join(', ')}${extra > 0 ? ` +${extra} more` : ''}`)
  }
  if (lines.length === 0) return ''
  const overflow = (n: number) =>
    `- …plus ${n} more upstream${n === 1 ? '' : 's'} with playbooks — check \`list_upstreams.attached_skills\`.`
  const compose = (named: string[], rest: number) =>
    GUIDANCE_HEADER + [...named, ...(rest > 0 ? [overflow(rest)] : [])].join('\n') + '\n\n'
  const full = compose(lines, 0)
  if (full.length <= budget) return full
  // Largest fitting prefix of named lines; the remainder collapses into
  // the overflow pointer. keep = 0 (header + pointer alone) always fits
  // any budget the static-block guard permits.
  for (let keep = lines.length - 1; keep >= 0; keep--) {
    const out = compose(lines.slice(0, keep), lines.length - keep)
    if (out.length <= budget) return out
  }
  return ''
}

/**
 * Tools hidden from the caller by per-tool ACL, with what would unlock
 * each. Powers `list_my_context.restrictedTools` — the discoverability
 * signal that lets the agent say "that tool needs role X" instead of
 * hitting a blank "tool not found". Scoped to upstreams the caller can
 * already SEE (we never reveal a tool on an upstream they can't see).
 * Reads the cached catalogue (no refresh) — best-effort advisory.
 * Takes the caller's visible rows + principals from the caller (the
 * `list_my_context` handler already holds both), and only reads the
 * catalogues of upstreams that actually carry ACL rows — often zero.
 */
export async function restrictedToolsFor(
  env: Env,
  rows: UpstreamServerRow[],
  principals: UserPrincipals
): Promise<McpRestrictedTool[]> {
  const dialable = rows.filter((r) => isDialableTransport(r.transport))
  if (dialable.length === 0) return []
  const aclRows = await listToolAccessForUpstreams(
    env,
    dialable.map((r) => r.id)
  )
  if (aclRows.length === 0) return []
  const acl = indexToolAccess(aclRows)
  // Only upstreams with ACL rows can produce restricted tools; skip the
  // catalogue read for the (common) unrestricted rest.
  const aclUpstreamIds = new Set(aclRows.map((r) => r.upstream_id))
  const toolsByUpstream = await listCachedToolsForUpstreams(env, [...aclUpstreamIds])
  const out: McpRestrictedTool[] = []
  for (const row of dialable) {
    const tools = toolsByUpstream.get(row.id) ?? []
    for (const t of tools) {
      const rules = acl.get(accessKey(row.id, t.tool_name))
      if (!rules || rules.length === 0) continue // open / inherit
      if (isToolAllowed(rules, principals)) continue // caller can call it
      out.push({ upstream: row.slug, tool: t.tool_name, requires: requiresFromRules(rules) })
    }
  }
  return out
}

/**
 * Catalogue for the `describe_upstream(slug)` built-in: one upstream's
 * tools by their NATIVE upstream names, grouped by the upstream's own
 * first-underscore family prefix, each with its callable mangled name +
 * a one-line summary. Cache-only (no dial). ACL-filtered to what the
 * caller can actually call — so it never leaks a tool registration would
 * hide. Returns null when the slug isn't visible to the caller (or
 * doesn't exist) so the handler can emit a single "not found".
 */
export async function describeUpstreamForUser(
  env: Env,
  userId: string,
  slug: string,
  opts?: { family?: string; query?: string }
): Promise<McpUpstreamTools | null> {
  const row = await getUpstreamVisibleToUser(env, userId, { slug })
  if (!row) return null
  const [principals, aclRows, cached, skills, docs] = await Promise.all([
    resolveUserPrincipals(env, userId),
    listToolAccessForUpstream(env, row.id),
    listCachedTools(env, row.id),
    // Published/org attachments only (default includeDrafts=false) — a
    // private draft never leaks onto describe_upstream, matching list_upstreams.
    listSkillsForUpstream(env, row.id),
    listDocsForUpstream(env, row.id)
  ])
  const acl = indexToolAccess(aclRows)
  const visible = visibleTools(row.id, cached, acl, principals)
  const whole = wholeUpstreamAttachments(skills, docs)
  return {
    slug: row.slug,
    displayName: row.display_name,
    toolsCount: visible.length,
    attached_skills: whole.skills,
    attached_docs: whole.docs,
    groups: groupToolsByFamily(row.slug, visible, perToolAttachments(skills, docs), opts)
  }
}

/**
 * Hydrate rows for the `list_upstreams()` built-in. Reports cached
 * tool count + connected state without forcing a connect. Disconnected
 * upstreams (missing user_bearer creds) are returned with `connected:
 * false` so agents know the deep-link to /upstreams.
 */
export async function listUpstreamsForUser(env: Env, userId: string): Promise<ListUpstreamsEntry[]> {
  const rows = (await listUpstreamsVisibleToUser(env, userId)).filter(
    (r): r is UpstreamServerRow & { transport: SupportedTransport } =>
      isDialableTransport(r.transport)
  )
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const credIds = rows
    .filter((r) => r.auth_strategy === 'user_bearer' || r.auth_strategy === 'user_oauth')
    .map((r) => r.id)
  const [credStatuses, toolCounts, skillsByUpstream, docsByUpstream, aclRows] = await Promise.all([
    getUserCredentialStatuses(env, userId, credIds),
    countToolsForUpstreams(env, ids),
    listSkillsForUpstreams(env, ids),
    listDocsForUpstreams(env, ids),
    listToolAccessForUpstreams(env, ids)
  ])
  // ACL-aware counts: subtract the tools the caller can't call (same
  // predicate `describe_upstream` uses via `visibleTools`) so the two
  // surfaces can never disagree. Fast path — the common no-ACL case
  // keeps the bare COUNT(*) with no extra reads.
  if (aclRows.length > 0) {
    const acl = indexToolAccess(aclRows)
    const principals = await resolveUserPrincipals(env, userId)
    const aclUpstreamIds = [...new Set(aclRows.map((r) => r.upstream_id))]
    const toolsByUpstream = await listCachedToolsForUpstreams(env, aclUpstreamIds)
    for (const id of aclUpstreamIds) {
      const cached = toolsByUpstream.get(id) ?? []
      toolCounts.set(id, visibleTools(id, cached, acl, principals).length)
    }
  }
  return rows.map((row) => {
    const requiresCred = row.auth_strategy === 'user_bearer' || row.auth_strategy === 'user_oauth'
    const cred = requiresCred
      ? (credStatuses.get(row.id) ?? { present: false, needsReauth: false })
      : { present: true, needsReauth: false }
    return upstreamEntry(
      row,
      cred,
      toolCounts.get(row.id) ?? 0,
      skillsByUpstream.get(row.id) ?? [],
      docsByUpstream.get(row.id) ?? []
    )
  })
}

/**
 * Agent-facing recovery note on needsReauth entries — paired with the
 * zeroed toolsCount below so the two signals can't be read apart.
 */
export const NEEDS_REAUTH_NOTE =
  'credential refresh failed — this session registered none of its tools; ' +
  'reconnect the upstream at /app/upstreams, then call reload_upstreams'

/**
 * One `list_upstreams` entry. Pure (exported for tests). On needsReauth
 * the reported toolsCount is 0 with an explanatory `note`: the session
 * registers NONE of the upstream's tools (credential-freshness gate), and
 * reporting the cached catalogue count made an agent plan work it could
 * not execute — "connected, 25 tools, needsReauth:true" reads as usable
 * (2026-08-27 Datadog field finding). Same surfaces-never-disagree rule
 * as the ACL-aligned counts above.
 */
export function upstreamEntry(
  row: UpstreamServerRow,
  cred: { present: boolean; needsReauth: boolean },
  toolsCount: number,
  skills: SkillForUpstreamRow[],
  docs: DocForUpstreamRow[]
): ListUpstreamsEntry {
  // Whole-upstream attachments only (tool_name = ''); per-tool
  // attachments surface via /api/upstreams/:id/tools.
  const attached_skills = skills
    .filter((s) => s.tool_name === '')
    .map((s) => ({ slug: s.slug, title: s.title }))
  const attached_docs = docs
    .filter((d) => d.tool_name === '')
    .map((d) => ({ id: d.doc_id, slug: d.slug, title: d.title }))
  return {
    slug: row.slug,
    displayName: row.display_name,
    transport: row.transport as SupportedTransport,
    connected: cred.present,
    ...(cred.needsReauth ? { needsReauth: true, note: NEEDS_REAUTH_NOTE } : {}),
    toolsCount: cred.needsReauth ? 0 : toolsCount,
    requiresAuth: row.auth_strategy,
    attached_skills,
    attached_docs
  }
}

// ----- pure helpers ------------------------------------------------------

export function truncateDescription(s: string, max = 1024): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * Condense a raw upstream tool description into a single-line summary for
 * the `describe_upstream` catalogue. Strips control characters (untrusted
 * model input — same rule as tool registration), collapses the newlines
 * `sanitizeUntrustedText` deliberately keeps into single spaces, and caps
 * the length. Returns '' for a null/empty description. We deliberately do
 * NOT try to extract a "first sentence" — upstream blurbs are riddled with
 * abbreviations ("e.g.", "i.e.", "System.Title") whose trailing dot is
 * followed by a space, so any period-boundary heuristic cuts early on them.
 * A clean flatten + cap is both robust and more informative. Operates on
 * the RAW `row.description` (no `[DisplayName]` prefix — that's added only
 * at registration), so summaries stay clean.
 */
export function summariseToolDescription(desc: string | null, max = 200): string {
  const flat = sanitizeUntrustedText(desc ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return truncateDescription(flat, max)
}

/**
 * Group an upstream's cached tools by their NATIVE name's first-underscore
 * family prefix, computed from the slug-collapsed name so it matches what
 * the agent sees. Each entry carries the verbatim upstream `name`, the
 * callable mangled `call` (via the same `mangleToolName` rule registration
 * uses — drift-proof), and a one-line `summary`. Optional `family` /
 * `query` filters narrow the result. Families sort alphabetically with the
 * ungrouped ('') bucket last; tools sort by name within a group. Pure.
 */
export function groupToolsByFamily(
  slug: string,
  tools: UpstreamToolRow[],
  attachments: Map<string, ToolAttachments>,
  opts?: { family?: string; query?: string }
): McpUpstreamToolGroup[] {
  const familyFilter = opts?.family?.toLowerCase()
  const queryFilter = opts?.query?.toLowerCase()
  const byFamily = new Map<string, McpUpstreamToolGroup['tools']>()
  for (const t of tools) {
    const family = toolFamily(slug, t.tool_name)
    if (familyFilter !== undefined && family.toLowerCase() !== familyFilter) continue
    const summary = summariseToolDescription(t.description)
    if (
      queryFilter !== undefined &&
      !t.tool_name.toLowerCase().includes(queryFilter) &&
      !summary.toLowerCase().includes(queryFilter)
    ) {
      continue
    }
    const att = attachments.get(t.tool_name)
    const entry = {
      name: t.tool_name,
      call: mangleToolName(slug, t.tool_name),
      summary,
      attached_skills: att?.skills ?? [],
      attached_docs: att?.docs ?? []
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
 * Filter cached tools down to the ones the caller may actually call, using
 * the exact same per-tool ACL predicate registration applies. Load-bearing
 * for `describe_upstream`: without it the catalogue would leak
 * names/summaries of tools hidden by ACL. Pure.
 */
export function visibleTools(
  upstreamId: string,
  tools: UpstreamToolRow[],
  acl: ReturnType<typeof indexToolAccess>,
  principals: UserPrincipals
): UpstreamToolRow[] {
  return tools.filter((t) => isToolAllowed(acl.get(accessKey(upstreamId, t.tool_name)), principals))
}

/**
 * Whole-upstream attachment pointers (tool_name = '') as ready-to-render
 * ref strings, in skills-then-docs order. These name the org playbook for
 * the WHOLE upstream and feed the server `instructions` leading block
 * (`upstreamGuidance`), whose header names the fetch tools once — so no
 * per-ref `(get_skill)` here, unlike `perToolPointers`, whose refs render
 * standalone on tool descriptions. Per-tool rows (tool_name != '') are
 * skipped here; `perToolPointers` owns those.
 */
export function wholeUpstreamPointers(
  skills: SkillForUpstreamRow[],
  docs: DocForUpstreamRow[]
): string[] {
  return [
    ...skills.filter((s) => s.tool_name === '').map((s) => `skill \`${s.slug}\``),
    ...docs.filter((d) => d.tool_name === '').map((d) => `doc \`${d.slug}\``)
  ]
}

/**
 * Group per-tool attachment pointers (tool_name != '') by upstream tool
 * name. Whole-upstream rows (tool_name = '') are skipped here — they are
 * named in the server `instructions` and `list_upstreams.attached_skills`.
 * Skills and docs are merged into one ordered list per tool so a tool can
 * carry both.
 */
export function perToolPointers(
  skills: SkillForUpstreamRow[],
  docs: DocForUpstreamRow[]
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (toolName: string, ref: string) => {
    if (toolName === '') return
    const arr = out.get(toolName) ?? []
    arr.push(ref)
    out.set(toolName, arr)
  }
  for (const s of skills) add(s.tool_name, `skill \`${s.slug}\` (get_skill)`)
  for (const d of docs) add(d.tool_name, `doc \`${d.slug}\` (get_doc)`)
  return out
}

/** Structured per-tool attachment refs for one tool (fed into `describe_upstream`). */
export interface ToolAttachments {
  skills: McpAttachedSkillRef[]
  docs: McpAttachedDocRef[]
}

/**
 * Per-tool (tool_name != '') attachments grouped by native upstream tool name,
 * as STRUCTURED data for `describe_upstream` — the agent decides whether to
 * fetch them via get_skill/get_doc. This is the structured replacement for the
 * per-tool imperative that used to ride the tool description. Whole-upstream
 * attachments (tool_name = '') are excluded here; they ride
 * `list_upstreams.attached_skills`. Mirrors `perToolPointers` but emits
 * `{slug,title}` / `{id,slug,title}` objects instead of prose ref strings.
 */
export function perToolAttachments(
  skills: SkillForUpstreamRow[],
  docs: DocForUpstreamRow[]
): Map<string, ToolAttachments> {
  const out = new Map<string, ToolAttachments>()
  const bucket = (toolName: string): ToolAttachments => {
    let b = out.get(toolName)
    if (!b) {
      b = { skills: [], docs: [] }
      out.set(toolName, b)
    }
    return b
  }
  for (const s of skills) {
    if (s.tool_name !== '') bucket(s.tool_name).skills.push({ slug: s.slug, title: s.title })
  }
  for (const d of docs) {
    if (d.tool_name !== '')
      bucket(d.tool_name).docs.push({ id: d.doc_id, slug: d.slug, title: d.title })
  }
  return out
}

/**
 * Whole-upstream (tool_name = '') attachments as structured refs for the
 * `describe_upstream` top level — the same set `list_upstreams` reports,
 * mirrored so a drill-in shows the upstream's governing playbooks alongside
 * its tools. Per-tool rows are excluded here (`perToolAttachments` owns those).
 */
export function wholeUpstreamAttachments(
  skills: SkillForUpstreamRow[],
  docs: DocForUpstreamRow[]
): ToolAttachments {
  return {
    skills: skills.filter((s) => s.tool_name === '').map((s) => ({ slug: s.slug, title: s.title })),
    docs: docs
      .filter((d) => d.tool_name === '')
      .map((d) => ({ id: d.doc_id, slug: d.slug, title: d.title }))
  }
}
