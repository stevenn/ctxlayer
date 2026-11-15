import type { Env } from '../../env'

/**
 * D1 queries for the stateless lane's first-result hint ledger
 * (`mcp_hint_ledger`, migration 0042).
 */

export interface HintKey {
  userId: string
  clientKey: string
  upstreamId: string
}

/**
 * Atomically claim the right to deliver the hint for this key. Returns true
 * when the caller should deliver it: there was no row, or the existing row is
 * older than the re-arm window (and is now stamped `nowSec`). Returns false
 * when a hint was delivered inside the window.
 *
 * One statement, so two concurrent first calls cannot both claim: the upsert
 * only RETURNs a row for the writer that actually inserted or advanced it.
 */
export async function claimHint(
  env: Env,
  key: HintKey,
  nowSec: number,
  rearmSeconds: number
): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO mcp_hint_ledger (user_id, client_key, upstream_id, hinted_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id, client_key, upstream_id) DO UPDATE
       SET hinted_at = excluded.hinted_at
       WHERE mcp_hint_ledger.hinted_at <= ?5
     RETURNING hinted_at`
  )
    .bind(key.userId, key.clientKey, key.upstreamId, nowSec, nowSec - rearmSeconds)
    .first<{ hinted_at: number }>()
  return row != null
}

/** Nightly prune: drop ledger rows not touched for `daysToKeep` days. */
export async function pruneHintLedger(env: Env, daysToKeep: number): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - daysToKeep * 86400
  const res = await env.DB.prepare(`DELETE FROM mcp_hint_ledger WHERE hinted_at < ?1`)
    .bind(cutoff)
    .run()
  return res.meta.changes ?? 0
}
