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
import { spaUrl, UPSTREAMS_PAGE } from '../util/spa-url'
import { getUserCredentialStatus, type CredentialStatus } from '../db/queries/upstream-credentials'

export interface FreshnessConn {
  id: string
  slug: string
  authStrategy: string
}

export interface CredentialFreshness {
  /** Agent-facing block text, or null when the call may proceed. */
  error: string | null
  /**
   * The status row the check read — null for shared/none strategies, which
   * have no per-user credential. Returned so the proxy can reuse the same
   * point-read for its "did the stored credential change since I bound this
   * upstream's client?" stamp comparison instead of reading twice per call.
   */
  status: CredentialStatus | null
}

/**
 * The per-call gate. `error` is first-party guidance (no upstream input),
 * safe to surface. The recovery is a BROWSER step only the user can take, so
 * the text names the page and says to simply retry afterwards — the proxy
 * rebinds the upstream on the next call once a fresh credential is on file
 * (see `UpstreamProxyRegistry.ensureBound`); no reload_upstreams, and no
 * reconnect of the MCP connector, is needed.
 */
export async function checkCredentialFreshness(
  env: Env,
  userId: string,
  conn: FreshnessConn
): Promise<CredentialFreshness> {
  if (conn.authStrategy !== 'user_bearer' && conn.authStrategy !== 'user_oauth') {
    return { error: null, status: null }
  }
  const status = await getUserCredentialStatus(env, userId, conn.id)
  if (status.present && !status.needsReauth) return { error: null, status }
  const reason = status.present
    ? 'requires re-authorization (its authorization expired or was revoked, and could not be refreshed)'
    : 'has been disconnected'
  const upstreamsUrl = spaUrl(env, UPSTREAMS_PAGE)
  return {
    error:
      `credential_revoked: your ${conn.slug} connection ${reason}. ` +
      `Nothing was sent to ${conn.slug}. The user must re-authorize it at ${upstreamsUrl} — ` +
      `then just retry this call. Reconnecting this MCP connector does not fix it.`,
    status
  }
}

/** The block text alone — see `checkCredentialFreshness`. */
export async function credentialFreshnessError(
  env: Env,
  userId: string,
  conn: FreshnessConn
): Promise<string | null> {
  return (await checkCredentialFreshness(env, userId, conn)).error
}
