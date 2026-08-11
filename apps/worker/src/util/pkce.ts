/**
 * PKCE (RFC 7636) verifier + S256 challenge, shared by the IdP sign-in
 * dance and the static (non-DCR) upstream OAuth flow. The DCR path does
 * not use these — the MCP SDK's `auth()` generates its own PKCE pair.
 */

import { b64urlEncode, randomToken } from './base64url'

export function pkceVerifier(): string {
  // RFC 7636: 43–128 unreserved chars. 32 random bytes -> ~43 b64url chars.
  return randomToken(32)
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return b64urlEncode(new Uint8Array(digest))
}
