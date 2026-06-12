/**
 * Cron-liveness heartbeat. The scheduled() handler stamps `ops:last_cron`
 * (unix seconds) in KV on every cron firing; /api/health reads it to detect a
 * stalled scheduler (which is otherwise invisible — a dead cron emits nothing).
 * Shared so the writer (index.ts) and reader (api/health.ts) can't drift on the
 * key or the staleness threshold.
 */

export const LAST_CRON_KV_KEY = 'ops:last_cron'

// The hourly cron is the heartbeat. Allow one full interval + 15min grace
// before calling the scheduler stale.
export const CRON_STALE_AFTER_S = 3600 + 15 * 60
