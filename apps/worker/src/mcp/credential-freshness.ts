/**
 * A6 (2026-08 review): per-call credential freshness for user-scoped
 * upstream strategies.
 *
 * User credentials are decrypted and bound to the upstream client when the
 * MCP session initialises, so without this check a mid-session disconnect
 * (user removes the connection), admin wipe, or reauth-required flag would
 * keep working until the session dies. One D1 point-read per call makes
 * revocation bite within one call instead. The async job path re-resolves
 * the bearer from D1 at execution time, so the inline path was the only
 * stale window — but the guard runs before the async SUBMIT too, so a
 * revoked user can't queue new jobs either.
 *
 * Shared/none strategies are exempt: they are org-wide operator config,
 * not a per-user grant, and revocation there is an upstream-disable.
 */

import type { Env } from '../env'
import { getUserCredentialStatus } from '../db/queries/upstream-credentials'

export interface FreshnessConn {
  id: string
  slug: string
  authStrategy: string
}

/**
 * Returns the agent-facing error text when the user's credential for this
 * upstream is gone or flagged for re-auth, or null when the call may
 * proceed. First-party guidance (no upstream input), safe to surface.
 */
export async function credentialFreshnessError(
  env: Env,
  userId: string,
  conn: FreshnessConn
): Promise<string | null> {
  if (conn.authStrategy !== 'user_bearer' && conn.authStrategy !== 'user_oauth') return null
  const status = await getUserCredentialStatus(env, userId, conn.id)
  if (status.present && !status.needsReauth) return null
  const reason = status.present
    ? 'requires re-authorization (its token could not be refreshed)'
    : 'has been disconnected'
  return (
    `credential_revoked: your ${conn.slug} connection ${reason}. ` +
    `Reconnect it on the ctxlayer Upstreams page, then call reload_upstreams ` +
    `(or start a new session).`
  )
}
