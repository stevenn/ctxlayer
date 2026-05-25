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
import type { Env } from '../env'
import { open as openSecret, type SealedSecret } from '../crypto/aead'
import {
  getUserCredential,
  type UpstreamConnection,
  type UpstreamServerRow
} from '../db/queries/upstreams'
import { UpstreamOAuthProvider } from './oauth-provider'

export async function resolveUserUpstreamBearer(
  env: Env,
  row: UpstreamServerRow,
  conn: UpstreamConnection,
  userId: string
): Promise<string | null> {
  if (conn.authStrategy === 'none') return null
  if (conn.authStrategy === 'shared_bearer') {
    // shared_bearer storage lands in M5 Phase 2 (separate table +
    // admin form). Until then this strategy has no usable bearer.
    return null
  }
  if (conn.authStrategy === 'user_oauth') {
    const provider = new UpstreamOAuthProvider(env, row, userId)
    try {
      const result = await mcpAuth(provider, { serverUrl: conn.url })
      if (result === 'AUTHORIZED') {
        return (await provider.tokens())?.access_token ?? null
      }
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
