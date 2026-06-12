/**
 * D1 queries for the `upstream_tools` catalogue cache — the per-upstream
 * snapshot of the last successful `tools/list` from that server.
 *
 * Rows are shared across users (the catalogue is not credential-scoped).
 * M8 staleness tracking lives here too: each row carries a canonical
 * input-schema hash plus the timestamp + summary of the last schema
 * change, which `db/queries/skills.ts` reads to flag stale skills.
 *
 * Upstream row CRUD lives in `upstreams.ts`; credentials in
 * `upstream-credentials.ts`.
 */

import type { Env } from '../../env'

export interface UpstreamToolRow {
  upstream_id: string
  tool_name: string
  description: string | null
  input_schema: string
  cached_at: number
  // M8: catalogue staleness tracking. NULL on rows cached before the
  // 0012 migration; populated on subsequent refreshes.
  input_schema_hash: string | null
  last_schema_change_at: number | null
  last_diff_summary: string | null
}

export interface CatalogueTool {
  toolName: string
  description: string | null
  inputSchema: unknown
}

export async function listCachedTools(env: Env, upstreamId: string): Promise<UpstreamToolRow[]> {
  const res = await env.DB.prepare(
    `SELECT upstream_id, tool_name, description, input_schema, cached_at,
            input_schema_hash, last_schema_change_at, last_diff_summary
     FROM upstream_tools WHERE upstream_id = ?1
     ORDER BY tool_name`
  )
    .bind(upstreamId)
    .all<UpstreamToolRow>()
  return res.results ?? []
}

export async function getToolsCachedAt(env: Env, upstreamId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT MAX(cached_at) AS cached_at FROM upstream_tools WHERE upstream_id = ?1`
  )
    .bind(upstreamId)
    .first<{ cached_at: number | null }>()
  return row?.cached_at ?? null
}

export async function countToolsForUpstream(env: Env, upstreamId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM upstream_tools WHERE upstream_id = ?1`
  )
    .bind(upstreamId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Batch variant of `listCachedTools`: one `IN (...)` query for many
 * upstreams, grouped by upstream_id with the same per-upstream tool_name
 * order. Upstreams with an empty cache simply have no map entry.
 */
export async function listCachedToolsForUpstreams(
  env: Env,
  upstreamIds: string[]
): Promise<Map<string, UpstreamToolRow[]>> {
  const out = new Map<string, UpstreamToolRow[]>()
  if (upstreamIds.length === 0) return out
  const placeholders = upstreamIds.map((_, i) => `?${i + 1}`).join(', ')
  const res = await env.DB.prepare(
    `SELECT upstream_id, tool_name, description, input_schema, cached_at,
            input_schema_hash, last_schema_change_at, last_diff_summary
     FROM upstream_tools WHERE upstream_id IN (${placeholders})
     ORDER BY upstream_id, tool_name`
  )
    .bind(...upstreamIds)
    .all<UpstreamToolRow>()
  for (const row of res.results ?? []) {
    const arr = out.get(row.upstream_id)
    if (arr) arr.push(row)
    else out.set(row.upstream_id, [row])
  }
  return out
}

/** Batch variant of `countToolsForUpstream`: one GROUP BY query. */
export async function countToolsForUpstreams(
  env: Env,
  upstreamIds: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (upstreamIds.length === 0) return out
  const placeholders = upstreamIds.map((_, i) => `?${i + 1}`).join(', ')
  const res = await env.DB.prepare(
    `SELECT upstream_id, COUNT(*) AS n FROM upstream_tools
     WHERE upstream_id IN (${placeholders}) GROUP BY upstream_id`
  )
    .bind(...upstreamIds)
    .all<{ upstream_id: string; n: number }>()
  for (const row of res.results ?? []) out.set(row.upstream_id, row.n)
  return out
}

/**
 * Replace the entire tool cache for an upstream — the authoritative
 * `tools/list` is what just came back. M8: also computes
 * input_schema_hash per tool and bumps last_schema_change_at when the
 * hash differs from the previously cached value. Skills attached to a
 * tool whose hash changed are reported as stale at read time
 * (apps/worker/src/db/queries/skills.ts).
 *
 * Implementation: read current hashes first, then DELETE + INSERT in
 * one batch. We INSERT with the right `last_schema_change_at` for each
 * row inline, so post-batch reads see consistent values.
 */
export async function replaceCachedTools(
  env: Env,
  upstreamId: string,
  tools: CatalogueTool[]
): Promise<number> {
  const now = Math.floor(Date.now() / 1000)

  // Snapshot prior hashes + change timestamps so we can decide whether
  // a given tool's hash changed and what to preserve.
  const prior = await env.DB.prepare(
    `SELECT tool_name, input_schema, input_schema_hash,
            last_schema_change_at, last_diff_summary
     FROM upstream_tools WHERE upstream_id = ?1`
  )
    .bind(upstreamId)
    .all<{
      tool_name: string
      input_schema: string
      input_schema_hash: string | null
      last_schema_change_at: number | null
      last_diff_summary: string | null
    }>()
  const priorByName = new Map(
    (prior.results ?? []).map((r) => [
      r.tool_name,
      {
        rawSchema: r.input_schema,
        hash: r.input_schema_hash,
        lastChangeAt: r.last_schema_change_at,
        diffSummary: r.last_diff_summary
      }
    ])
  )

  // Compute hash + diff per tool (lazy import to keep cold-start lean).
  const { canonicalHash, summariseDiff } = await import('../../upstream/schema-diff')
  type Prepared = {
    toolName: string
    description: string | null
    schemaJson: string
    schemaHash: string
    lastChangeAt: number | null
    diffSummary: string | null
  }
  const prepared: Prepared[] = []
  for (const t of tools) {
    const schemaJson = JSON.stringify(t.inputSchema ?? {})
    const schemaHash = await canonicalHash(t.inputSchema ?? {})
    const priorRow = priorByName.get(t.toolName)
    if (!priorRow) {
      // New tool: record the hash; leave last_schema_change_at NULL
      // (first sight isn't a "change" — there's nothing to diff
      // against).
      prepared.push({
        toolName: t.toolName,
        description: t.description ?? null,
        schemaJson,
        schemaHash,
        lastChangeAt: null,
        diffSummary: null
      })
      continue
    }
    if (priorRow.hash === schemaHash) {
      // Unchanged: preserve BOTH the prior change timestamp AND the
      // prior diff summary. Nulling the summary here (as the
      // pre-2026-05-29 code did) made the SPA hover disappear on the
      // very next no-change refresh — operators would see "schema
      // changed Xh ago" with no tooltip explaining what changed.
      prepared.push({
        toolName: t.toolName,
        description: t.description ?? null,
        schemaJson,
        schemaHash,
        lastChangeAt: priorRow.lastChangeAt,
        diffSummary: priorRow.diffSummary
      })
      continue
    }
    if (priorRow.hash === null) {
      // First refresh after the 0012 migration on a row that existed
      // pre-migration. We don't have a prior hash to compare against,
      // so this isn't a "change" we can honestly attribute. Record
      // the new hash but leave the change timestamp + summary
      // untouched (NULL). The next genuine change will set both.
      prepared.push({
        toolName: t.toolName,
        description: t.description ?? null,
        schemaJson,
        schemaHash,
        lastChangeAt: priorRow.lastChangeAt,
        diffSummary: priorRow.diffSummary
      })
      continue
    }
    // Real change: hashes differ AND we have a real prior hash to
    // compare against. Diff + bump.
    let oldSchema: unknown = {}
    try {
      oldSchema = JSON.parse(priorRow.rawSchema)
    } catch {
      /* swallow */
    }
    const summary = summariseDiff(oldSchema, t.inputSchema ?? {})
    prepared.push({
      toolName: t.toolName,
      description: t.description ?? null,
      schemaJson,
      schemaHash,
      lastChangeAt: now,
      diffSummary: summary
    })
  }

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM upstream_tools WHERE upstream_id = ?1`).bind(upstreamId)
  ]
  for (const p of prepared) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO upstream_tools
           (upstream_id, tool_name, description, input_schema, cached_at,
            input_schema_hash, last_schema_change_at, last_diff_summary)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      ).bind(
        upstreamId,
        p.toolName,
        p.description,
        p.schemaJson,
        now,
        p.schemaHash,
        p.lastChangeAt,
        p.diffSummary
      )
    )
  }
  await env.DB.batch(stmts)
  return now
}
