/**
 * Env-allowlist primitives consumed by the admission resolver
 * (auth/admission.ts). Two distinct notions (plan L §5/§6):
 *
 *   - EXPLICIT per-user allowlist (`ALLOWED_GITHUB_USERS` /
 *     `ALLOWED_GOOGLE_EMAILS`) — a break-glass / solo-operator grant that
 *     always admits as `active`, under any ACCESS_POLICY.
 *   - DOMAIN/ORG pre-filter (`ALLOWED_GITHUB_ORG` / `ALLOWED_GOOGLE_HD`) —
 *     "is a member of the org/domain". Under `open_domain` it admits; under
 *     `request` it lands pending; under `invite` it's not sufficient alone.
 *
 * These functions answer the two questions separately so the resolver can
 * layer policy on top. The GitHub org check is the only one that hits the
 * network, so it's a separate async call the resolver makes lazily.
 */

import type { Env } from '../env'

export type AdmissionIdentity =
  | { idp: 'github'; login: string; email: string; accessToken: string }
  | { idp: 'google'; email: string; hd?: string }

function parseList(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  )
}

/** True when the identity is on the explicit per-user allowlist (break-glass). */
export function isExplicitlyAllowlisted(id: AdmissionIdentity, env: Env): boolean {
  if (id.idp === 'github') return parseList(env.ALLOWED_GITHUB_USERS).has(id.login.toLowerCase())
  return parseList(env.ALLOWED_GOOGLE_EMAILS).has(id.email.toLowerCase())
}

/** True when the IdP has ANY allowlist configured (explicit OR domain). */
export function idpAllowlistConfigured(idp: 'github' | 'google', env: Env): boolean {
  if (idp === 'github') {
    return parseList(env.ALLOWED_GITHUB_USERS).size > 0 || !!env.ALLOWED_GITHUB_ORG
  }
  return parseList(env.ALLOWED_GOOGLE_EMAILS).size > 0 || !!env.ALLOWED_GOOGLE_HD
}

/**
 * True when a DOMAIN/ORG pre-filter is configured for this IdP
 * (`ALLOWED_GITHUB_ORG` / `ALLOWED_GOOGLE_HD`) — i.e. there's a membership
 * boundary to gate on. Distinct from the explicit per-user lists. Used by the
 * `request` policy to decide between a members-only queue (boundary set) and
 * an open queue (no boundary → anyone who can sign in lands pending).
 */
export function domainPrefilterConfigured(idp: 'github' | 'google', env: Env): boolean {
  return idp === 'github' ? !!env.ALLOWED_GITHUB_ORG : !!env.ALLOWED_GOOGLE_HD
}

/**
 * The domain/org membership pre-filter. For Google this is a synchronous
 * `hd` claim check; for GitHub it requires the org-membership API call, so
 * the whole helper is async. Returns false (not throw) on any miss — the
 * resolver maps a miss to the right policy outcome.
 */
export async function passesDomainPrefilter(id: AdmissionIdentity, env: Env): Promise<boolean> {
  if (id.idp === 'google') {
    return !!env.ALLOWED_GOOGLE_HD && id.hd === env.ALLOWED_GOOGLE_HD
  }
  if (!env.ALLOWED_GITHUB_ORG) return false
  const res = await fetch('https://api.github.com/user/orgs', {
    headers: {
      Authorization: `Bearer ${id.accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ctxlayer'
    }
  })
  if (!res.ok) return false
  const orgs = (await res.json()) as Array<{ login: string }>
  return orgs.some((o) => o.login === env.ALLOWED_GITHUB_ORG)
}
