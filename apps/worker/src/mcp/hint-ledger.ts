/**
 * Once-per-session state for the first-result playbook hint
 * (docs/plan/O-result-skill-hint.md). McpSessionDO HIBERNATES between
 * requests, so in-memory registry state dies on every wake — field-caught
 * 2026-08-27: the hint fired on consecutive calls because each wake
 * re-ran init() and re-armed it. "Already hinted" therefore lives in the
 * session DO's own SQLite, the same home as the usage outbox. The
 * in-memory variant backs unit tests and the storage-less default.
 */

export interface HintLedger {
  wasHinted(upstreamId: string): boolean
  markHinted(upstreamId: string): void
}

export function inMemoryHintLedger(): HintLedger {
  const hinted = new Set<string>()
  return {
    wasHinted: (id) => hinted.has(id),
    markHinted: (id) => void hinted.add(id)
  }
}

/** Durable ledger in the session DO's SQLite — survives hibernation. */
export function sqliteHintLedger(sql: SqlStorage): HintLedger {
  sql.exec(`CREATE TABLE IF NOT EXISTS hinted_upstreams (upstream_id TEXT PRIMARY KEY)`)
  return {
    wasHinted: (id) =>
      sql.exec(`SELECT 1 FROM hinted_upstreams WHERE upstream_id = ?`, id).toArray().length > 0,
    markHinted: (id) =>
      void sql.exec(`INSERT OR IGNORE INTO hinted_upstreams (upstream_id) VALUES (?)`, id)
  }
}
