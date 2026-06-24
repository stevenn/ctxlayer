/**
 * Cloudflare Access (Zero Trust) JWT trust.
 *
 * When the app is deployed behind Cloudflare Access, the edge authenticates
 * the user against the configured IdP and forwards every request with a signed
 * JWT in the `Cf-Access-Jwt-Assertion` header. This module verifies that JWT so
 * the app can trust the asserted identity instead of running its own IdP OAuth.
 *
 * Generic by design — nothing here is deployment-specific. The team domain and
 * the Access application AUD are supplied via env (CF_ACCESS_TEAM_DOMAIN,
 * CF_ACCESS_AUD); when both are set, `accessTrustConfigured()` is true and the
 * auth middleware will accept a valid Access token as an identity source.
 *
 * Verification: RS256 over the JWKS published at
 * `https://<team-domain>/cdn-cgi/access/certs`, plus issuer + audience + expiry
 * checks. Any failure returns null — callers treat that as "not authenticated
 * via Access" and fall through to the normal (cookie / IdP) path.
 */

import type { Env } from '../env'
import { b64urlDecode } from './session'

export interface AccessIdentity {
  /** Stable per-user subject from the Access token (`sub`). */
  sub: string
  /** The authenticated user's email, lower-cased (`email` claim). */
  email: string
  /** Display name if the token carries one; usually absent. */
  name: string | null
}

/** Access trust is active only when BOTH the team domain and AUD are set. */
export function accessTrustConfigured(env: Env): boolean {
  return !!(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD)
}

interface Jwk {
  kid: string
  kty: string
  n: string
  e: string
  alg?: string
}

// Module-global JWKS cache, keyed by team domain. Access rotates signing keys,
// so we cache on a short TTL and also force a refetch on a kid miss rather than
// pinning a key set.
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAtMs: number }>()
const JWKS_TTL_MS = 60 * 60 * 1000 // 1h

async function getJwks(teamDomain: string, force = false): Promise<Jwk[]> {
  const nowMs = Date.now()
  const cached = jwksCache.get(teamDomain)
  if (!force && cached && nowMs - cached.fetchedAtMs < JWKS_TTL_MS) return cached.keys
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`access certs fetch failed: ${res.status}`)
  const body = (await res.json()) as { keys?: Jwk[] }
  const keys = body.keys ?? []
  jwksCache.set(teamDomain, { keys, fetchedAtMs: nowMs })
  return keys
}

async function importRsaKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  )
}

/**
 * Verify a Cloudflare Access application token. Returns the asserted identity
 * on success, or null on any failure (not configured, malformed, wrong
 * iss/aud, expired, bad signature) — callers treat null as "no Access identity".
 */
export async function verifyCfAccessJwt(
  jwt: string,
  env: Env,
  now: number = Math.floor(Date.now() / 1000)
): Promise<AccessIdentity | null> {
  const team = env.CF_ACCESS_TEAM_DOMAIN
  const aud = env.CF_ACCESS_AUD
  if (!team || !aud) return null

  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, sigB64] = parts
  if (!headerB64 || !payloadB64 || !sigB64) return null

  let header: { alg?: string; kid?: string }
  let claims: {
    iss?: string
    aud?: string | string[]
    exp?: number
    nbf?: number
    email?: string
    sub?: string
    name?: string
  }
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(headerB64)))
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)))
  } catch {
    return null
  }
  if (header.alg !== 'RS256' || !header.kid) return null

  // Cheap claim checks before touching crypto.
  if (claims.iss !== `https://${team}`) return null
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(aud) : claims.aud === aud
  if (!audOk) return null
  if (typeof claims.exp !== 'number' || claims.exp < now) return null
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null
  if (!claims.email || !claims.sub) return null

  // Signature: find the key by kid, refetching once if it rotated out.
  let jwk: Jwk | undefined
  try {
    jwk = (await getJwks(team)).find((k) => k.kid === header.kid)
    if (!jwk) jwk = (await getJwks(team, true)).find((k) => k.kid === header.kid)
  } catch {
    return null
  }
  if (!jwk) return null

  let valid = false
  try {
    const key = await importRsaKey(jwk)
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(sigB64), data)
  } catch {
    return null
  }
  if (!valid) return null

  return { sub: claims.sub, email: claims.email.toLowerCase(), name: claims.name ?? null }
}
