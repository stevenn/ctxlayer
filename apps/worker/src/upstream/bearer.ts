/**
 * Per-user bearer resolution shared by the in-session proxy registry
 * (`mcp/tools-proxy.ts`) and the admin "Refresh now" endpoint
 * (`api/admin-upstreams.ts`).
 *
 * For each auth strategy the function returns one of:
 *   - a usable Bearer string (auth header value, sans "Bearer " prefix);
 *   - `null` to signal "no credentials available" (the caller decides
 *     whether that's an error or just "skip this upstream").
 *
 * Note on user_oauth: we go through the SDK's `auth()` orchestrator so
 * an expired access token is transparently refreshed. The orchestrator
 * has a quirk where it ALWAYS attempts a refresh when a refresh_token
 * is present (regardless of access_token freshness); if Notion (or any
 * upstream) returns an unstructured error on refresh, auth() silently
 * falls through to a new authorization flow and returns 'REDIRECT' —
 * we treat that as "no usable bearer" and log it.
 */

import { auth as mcpAuth } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  OAuthError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Env } from '../env'
import { audit } from '../audit/log'
import { open as openSecret, type SealedSecret } from '../crypto/aead'
import {
  parseAuthConfig,
  type UpstreamConnection,
  type UpstreamServerRow
} from '../db/queries/upstreams'
import {
  getSharedCredential,
  getUserCredential,
  getUserCredentialStatus,
  markReauthRequired
} from '../db/queries/upstream-credentials'
import { UpstreamOAuthProvider } from './oauth-provider'
import { singleFlightRefresh } from './oauth-refresh'
import { refreshStaticDetailed, staticOAuth } from './oauth-static'
import { errMessage } from '../util/errors'
import { scrubErrorForStorage } from '../usage/error-detail'

// Refresh a user_oauth access token only when it's within this many
// seconds of expiry. Going through the SDK's auth() on EVERY bearer
// resolution eagerly refreshes — and thus ROTATES — the refresh token;
// with single-use rotating refresh tokens, repeated session reconnects
// churned the rotations until all upstreams' refresh tokens were
// invalidated ("Invalid refresh token" / reuse-detection). Using a still-
// fresh access token directly avoids that, so we refresh ~once per token
// lifetime instead of once per session init.
const OAUTH_REFRESH_BUFFER_S = 5 * 60

export async function resolveUserUpstreamBearer(
  env: Env,
  row: UpstreamServerRow,
  conn: UpstreamConnection,
  userId: string
): Promise<string | null> {
  if (conn.authStrategy === 'none') return null
  if (conn.authStrategy === 'shared_bearer') {
    const shared = await getSharedCredential(env, conn.id)
    if (!shared) return null
    const sealed: SealedSecret = {
      ciphertext: shared.ciphertext,
      iv: shared.iv,
      keyVersion: shared.key_version
    }
    try {
      return await openSecret(sealed, env.ENCRYPTION_KEY)
    } catch (err) {
      const msg = errMessage(err)
      console.error(`[shared-bearer] ${conn.slug}: decrypt failed: ${msg}`)
      return null
    }
  }
  if (conn.authStrategy === 'user_oauth') {
    const provider = new UpstreamOAuthProvider(env, row, userId)
    // Static (pre-registered, non-DCR) clients — e.g. Entra fronting Azure
    // DevOps — drive their own refresh against the configured token endpoint
    // instead of the SDK's auth() orchestrator.
    const staticCfg = staticOAuth(parseAuthConfig(row.auth_config))

    // Fast path: a still-fresh access token is used as-is — no lease, no
    // refresh, no rotation (see OAUTH_REFRESH_BUFFER_S). Only when it's near
    // expiry do we refresh, and that refresh is single-flighted below so two
    // concurrent sessions/devices can't both spend a rotating refresh_token.
    const existing = await provider.tokens()
    if (isFreshAccessToken(existing)) return existing?.access_token ?? null
    const hadCreds = !!(existing?.access_token || existing?.refresh_token)

    // Flag the credential for interactive reconnect (once) so list_upstreams
    // tells the agent to reconnect; audit the clear→set transition. `reason`
    // is the refresh-failure mode (scrubbed + capped) — without it a flag is
    // undiagnosable after the fact, since the raw error only ever hits
    // console logs that aren't retained. May be absent when the lease loser
    // observed the failure (the winner's flag carries it).
    const flagReauth = async (reason?: string) => {
      if (await markReauthRequired(env, userId, row.id)) {
        await audit(env, {
          actorId: userId,
          action: 'upstream.reauth_required',
          target: row.id,
          meta: {
            slug: conn.slug,
            ...(reason ? { reason: scrubErrorForStorage(reason) } : {})
          }
        })
      }
    }

    if (staticCfg) {
      // Once a static credential is flagged for reauth (a prior refresh got
      // invalid_grant), its refresh token is dead until the user reconnects —
      // skip the refresh entirely. That avoids re-POSTing to the token endpoint
      // on every stale resolution and silences the repeat "[oauth-static] token
      // refresh failed" error log. The flag is cleared on reconnect
      // (exchangeCode → saveTokens → clearReauthRequired), after which refreshes
      // resume normally.
      if (hadCreds && (await getUserCredentialStatus(env, userId, row.id)).needsReauth) {
        return null
      }
      // Only the lease winner runs the refresh; capture whether it failed
      // PERMANENTLY (invalid_grant) so we flag reauth only then — a transient
      // network / 5xx failure must keep retrying, not lock the user out.
      let permanent = false
      let reason: string | undefined
      const token = await singleFlightRefresh(env, userId, row.id, {
        refresh: async () => {
          const r = await refreshStaticDetailed(env, provider, staticCfg)
          permanent = r.reauth
          reason = r.reason
          return r.token
        },
        readAccessToken: async () => (await provider.tokens())?.access_token ?? null,
        isFresh: async () => isFreshAccessToken(await provider.tokens())
      })
      if (permanent && hadCreds) await flagReauth(reason)
      return token
    }

    // DCR (SDK auth()) path. Failures are classified permanent vs transient
    // (see classifyDcrRefreshFailure) and only PERMANENT ones flag reauth —
    // a network blip / 5xx / rate-limit at the token endpoint must keep
    // retrying on later resolutions (and the nightly keep-warm), not lock
    // the user out. Mirrors the static path's invalid_grant-only rule.
    let permanent = false
    let failure: string | undefined
    const token = await singleFlightRefresh(env, userId, row.id, {
      refresh: async () => {
        const r = await refreshViaSdk(provider, conn, !!existing?.refresh_token)
        permanent = r.permanent
        failure = r.failure
        return r.token
      },
      readAccessToken: async () => (await provider.tokens())?.access_token ?? null,
      isFresh: async () => isFreshAccessToken(await provider.tokens())
    })
    if (token === null && hadCreds && permanent) await flagReauth(failure)
    return token
  }
  // user_bearer
  const cred = await getUserCredential(env, userId, conn.id)
  if (!cred) return null
  const sealed: SealedSecret = {
    ciphertext: cred.ciphertext,
    iv: cred.iv,
    keyVersion: cred.key_version
  }
  try {
    return await openSecret(sealed, env.ENCRYPTION_KEY)
  } catch (err) {
    const msg = errMessage(err)
    console.error(`[bearer] ${conn.slug}: decrypt failed: ${msg}`)
    return null
  }
}

/** A stored access token that is present and not within the refresh buffer. */
function isFreshAccessToken(t: OAuthTokens | undefined): boolean {
  return !!t?.access_token && t.expires_in !== undefined && t.expires_in > OAUTH_REFRESH_BUFFER_S
}

/**
 * DCR refresh via the MCP SDK's auth() orchestrator. auth() always runs a
 * refresh when a refresh_token is present, so the caller invokes this only
 * after the fast path has determined the access token is near expiry. A
 * non-AUTHORIZED outcome means the SDK wants a fresh interactive authz flow;
 * we surface a null token so the caller skips the upstream (the user
 * reconnects from /upstreams). `failure` records WHY for the reauth audit
 * entry; `permanent` drives whether the caller flags reauth at all.
 */
async function refreshViaSdk(
  provider: UpstreamOAuthProvider,
  conn: UpstreamConnection,
  hadRefreshToken: boolean
): Promise<{ token: string | null; permanent: boolean; failure?: string }> {
  try {
    const result = await mcpAuth(provider, { serverUrl: conn.url })
    if (result === 'AUTHORIZED') {
      return { token: (await provider.tokens())?.access_token ?? null, permanent: false }
    }
    const redirect = provider.capturedRedirect?.toString() ?? '<none>'
    console.warn(
      `[oauth] ${conn.slug}: refresh failed, SDK wants new authz flow (redirect=${redirect})`
    )
    return { token: null, ...classifyDcrRefreshFailure({ kind: 'redirect', result, hadRefreshToken }) }
  } catch (err) {
    console.error(`[oauth] ${conn.slug}: auth() threw: ${errMessage(err)}`)
    return { token: null, ...classifyDcrRefreshFailure({ kind: 'threw', err }) }
  }
}

/**
 * Permanent-vs-transient classification of a failed DCR refresh, mapped
 * from how SDK 1.29's auth() surfaces each failure mode (verified against
 * the vendored source; the 2026-08-27 Datadog invalid_grant arrived as a
 * thrown InvalidGrantError exactly as mapped here):
 *
 *  - authInternal's refresh catch SWALLOWS ServerError + non-OAuthError
 *    failures (5xx, unparseable bodies, network throws) and falls through
 *    to wanting a new interactive flow → we see `redirect`. With a
 *    refresh_token present that is the TRANSIENT bucket — the very
 *    failures that used to over-flag. Without one, `redirect` is the
 *    normal "nothing left to refresh" outcome: only an interactive
 *    reconnect can ever produce a token again, so it is permanent.
 *  - Structured OAuth errors are RE-THROWN (invalid_grant, invalid_client,
 *    unauthorized_client, invalid_scope, …) → permanent: the grant/client
 *    is dead until reconnect. Transient-shaped OAuth codes (server_error,
 *    temporarily_unavailable, too_many_requests) and non-OAuth throws
 *    (network failures during discovery) stay transient.
 *
 * NOTE this mapping depends on `UpstreamOAuthProvider` NOT implementing
 * `invalidateCredentials` — auth() would otherwise wipe the stored tokens
 * on invalid_grant and convert it into a `redirect`, destroying both the
 * classification signal and the evidence. Pinned by a test.
 */
export function classifyDcrRefreshFailure(
  outcome:
    | { kind: 'redirect'; result: string; hadRefreshToken: boolean }
    | { kind: 'threw'; err: unknown }
): { permanent: boolean; failure: string } {
  if (outcome.kind === 'redirect') {
    return outcome.hadRefreshToken
      ? { permanent: false, failure: `sdk_wants_new_authz:${outcome.result}` }
      : { permanent: true, failure: `no_refresh_token:${outcome.result}` }
  }
  const err = outcome.err
  const transient =
    !(err instanceof OAuthError) ||
    err instanceof ServerError ||
    err instanceof TemporarilyUnavailableError ||
    err instanceof TooManyRequestsError
  return { permanent: !transient, failure: `sdk_threw:${errMessage(err)}` }
}
