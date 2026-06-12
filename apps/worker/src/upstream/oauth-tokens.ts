/**
 * Sealed-token load/save scaffolding shared by the upstream OAuth provider
 * (`oauth-provider.ts`) and the git static-OAuth flow (`git/git-oauth.ts`).
 * Both persist the same JSON blob (sealed via crypto/aead) and convert
 * between the stored *absolute* `expires_at` and the SDK's *relative*
 * `expires_in`. Persistence (which table the blob lands in) stays with the
 * callers.
 */

import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Env } from '../env'
import { open as openSecret, seal as sealSecret, type SealedSecret } from '../crypto/aead'

export interface StoredOAuthTokens {
  access_token: string
  token_type?: string
  refresh_token?: string
  scope?: string
  /** Absolute unix seconds for when the access token expires. */
  expires_at?: number
}

/**
 * Open + parse a sealed StoredOAuthTokens blob and convert the absolute
 * expiry back to "seconds until expiry" so the SDK's freshness check
 * (`expires_in` <= 0 → refresh) keeps working. Decrypt/parse failures log
 * `<logLabel>:` + error and yield undefined (treated as "no tokens").
 */
export async function openStoredTokens(
  env: Env,
  sealed: SealedSecret,
  logLabel: string
): Promise<OAuthTokens | undefined> {
  try {
    const plaintext = await openSecret(sealed, env.ENCRYPTION_KEY)
    const stored = JSON.parse(plaintext) as StoredOAuthTokens
    return {
      access_token: stored.access_token,
      token_type: stored.token_type ?? 'Bearer',
      refresh_token: stored.refresh_token,
      scope: stored.scope,
      expires_in: stored.expires_at
        ? Math.max(0, stored.expires_at - Math.floor(Date.now() / 1000))
        : undefined
    }
  } catch (err) {
    console.error(`${logLabel}:`, err)
    return undefined
  }
}

/**
 * Merge an incoming token response with the prior stored tokens (rotation
 * safety — see mergeRefreshableTokens), convert the relative `expires_in`
 * to an absolute `expires_at`, and seal the blob for persistence. `readPrior`
 * is only invoked when the response omits refresh_token or scope.
 */
export async function prepareStoredTokens(
  env: Env,
  tokens: OAuthTokens,
  readPrior: () => Promise<OAuthTokens | undefined>
): Promise<{ sealed: SealedSecret; merged: { refresh_token?: string; scope?: string } }> {
  const now = Math.floor(Date.now() / 1000)
  const prior = !tokens.refresh_token || !tokens.scope ? await readPrior() : undefined
  const merged = mergeRefreshableTokens(tokens, prior)
  const stored: StoredOAuthTokens = {
    access_token: tokens.access_token,
    token_type: tokens.token_type,
    refresh_token: merged.refresh_token,
    scope: merged.scope,
    expires_at: tokens.expires_in ? now + tokens.expires_in : undefined
  }
  const sealed = await sealSecret(JSON.stringify(stored), env.ENCRYPTION_KEY)
  return { sealed, merged }
}

/**
 * Carry the prior refresh_token + scope forward when a refresh response
 * omits them (the access_token always comes from the new response). Keeps
 * a non-rotating provider's refresh_token alive across refreshes, so a
 * refresh that returns only a new access_token can't wipe our ability to
 * refresh again. Pure — unit-tested in oauth-provider.test.ts.
 */
export function mergeRefreshableTokens(
  incoming: OAuthTokens,
  prior: OAuthTokens | undefined
): { refresh_token?: string; scope?: string } {
  return {
    refresh_token: incoming.refresh_token ?? prior?.refresh_token,
    scope: incoming.scope ?? prior?.scope
  }
}
