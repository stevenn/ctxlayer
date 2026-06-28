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
      const msg = err instanceof Error ? err.message : String(err)
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
    // tells the agent to reconnect; audit the clear→set transition.
    const flagReauth = async () => {
      if (await markReauthRequired(env, userId, row.id)) {
        await audit(env, {
          actorId: userId,
          action: 'upstream.reauth_required',
          target: row.id,
          meta: { slug: conn.slug }
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
      const token = await singleFlightRefresh(env, userId, row.id, {
        refresh: async () => {
          const r = await refreshStaticDetailed(env, provider, staticCfg)
          permanent = r.reauth
          return r.token
        },
        readAccessToken: async () => (await provider.tokens())?.access_token ?? null,
        isFresh: async () => isFreshAccessToken(await provider.tokens())
      })
      if (permanent && hadCreds) await flagReauth()
      return token
    }

    // DCR (SDK auth()) path. The SDK exposes no permanent/transient signal, so
    // keep the prior behaviour: any failed refresh with creds present flags for
    // reauth (and retries on the next resolution).
    const token = await singleFlightRefresh(env, userId, row.id, {
      refresh: () => refreshViaSdk(provider, conn),
      readAccessToken: async () => (await provider.tokens())?.access_token ?? null,
      isFresh: async () => isFreshAccessToken(await provider.tokens())
    })
    if (token === null && hadCreds) await flagReauth()
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
    const msg = err instanceof Error ? err.message : String(err)
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
 * we surface null so the caller skips the upstream (the user reconnects from
 * /upstreams).
 */
async function refreshViaSdk(
  provider: UpstreamOAuthProvider,
  conn: UpstreamConnection
): Promise<string | null> {
  try {
    const result = await mcpAuth(provider, { serverUrl: conn.url })
    if (result === 'AUTHORIZED') return (await provider.tokens())?.access_token ?? null
    const redirect = provider.capturedRedirect?.toString() ?? '<none>'
    console.warn(
      `[oauth] ${conn.slug}: refresh failed, SDK wants new authz flow (redirect=${redirect})`
    )
    return null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[oauth] ${conn.slug}: auth() threw: ${msg}`)
    return null
  }
}
