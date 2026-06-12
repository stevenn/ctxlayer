/**
 * Append-only audit log for security-relevant actions.
 *
 * Conventions:
 *   - `action`: dotted lowercase identifier (`user.role_change`,
 *     `upstream.create`, `credential.revoke`). Stable across versions
 *     — admin UIs may filter on the prefix.
 *   - `actorId`: user.id of whoever initiated the action. For system
 *     paths (e.g. allowlist-driven admin promotion on first sign-in)
 *     pass the same id as `target`.
 *   - `target`: the entity being acted on (user id, upstream id, etc.).
 *     Free-form so we can audit things that don't fit one table.
 *   - `meta`: small JSON describing what changed. Don't put secrets
 *     in here — the audit log is reviewable by admins.
 *
 * Failures are best-effort: a logging error must not block the
 * underlying action. The caller's flow continues either way.
 */

import type { Env } from '../env'
import { insertAuditRow } from '../db/queries/audit'

export interface AuditEntry {
  actorId: string
  action: string
  target?: string | null
  meta?: Record<string, unknown> | null
}

export async function audit(env: Env, entry: AuditEntry): Promise<void> {
  try {
    await insertAuditRow(env, {
      id: crypto.randomUUID().replace(/-/g, ''),
      ts: Math.floor(Date.now() / 1000),
      actorId: entry.actorId,
      action: entry.action,
      target: entry.target ?? null,
      meta: entry.meta ? JSON.stringify(entry.meta) : null
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[audit] write failed for ${entry.action}: ${msg}`)
  }
}
