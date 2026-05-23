import type { Env } from '../env'
import type { ErrorReason } from '../idp/common'

export class AllowlistError extends Error {
  constructor(public reason: ErrorReason) {
    super(reason)
  }
}

interface GoogleProfile {
  hd?: string
  email: string
}

interface GithubAllowlistArgs {
  accessToken: string
  login: string
  env: Env
}

function parseList(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  )
}

/**
 * Google passes the allowlist when EITHER:
 *   - id_token.hd matches ALLOWED_GOOGLE_HD (Workspace domain check), OR
 *   - email is in ALLOWED_GOOGLE_EMAILS (per-user override).
 * Both empty disables Google entirely.
 */
export function enforceGoogleAllowlist(profile: GoogleProfile, env: Env): void {
  const emailSet = parseList(env.ALLOWED_GOOGLE_EMAILS)
  const hasEmailAllowlist = emailSet.size > 0
  const hasHdAllowlist = !!env.ALLOWED_GOOGLE_HD

  if (!hasEmailAllowlist && !hasHdAllowlist) {
    throw new AllowlistError('google_disabled')
  }
  if (hasEmailAllowlist && emailSet.has(profile.email.toLowerCase())) return
  if (hasHdAllowlist && profile.hd === env.ALLOWED_GOOGLE_HD) return
  throw new AllowlistError('wrong_domain')
}

/**
 * GitHub passes the allowlist when EITHER:
 *   - the user is a member of ALLOWED_GITHUB_ORG, OR
 *   - the user's login is in ALLOWED_GITHUB_USERS.
 * Both empty disables GitHub. ALLOWED_GITHUB_USERS is the cheap path
 * (no API call) — checked first.
 */
export async function enforceGithubAllowlist({
  accessToken,
  login,
  env
}: GithubAllowlistArgs): Promise<void> {
  const userSet = parseList(env.ALLOWED_GITHUB_USERS)
  const hasUserAllowlist = userSet.size > 0
  const hasOrgAllowlist = !!env.ALLOWED_GITHUB_ORG

  if (!hasUserAllowlist && !hasOrgAllowlist) {
    throw new AllowlistError('github_disabled')
  }

  if (hasUserAllowlist && userSet.has(login.toLowerCase())) return

  if (hasOrgAllowlist) {
    const res = await fetch('https://api.github.com/user/orgs', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ctxlayer'
      }
    })
    if (res.ok) {
      const orgs = (await res.json()) as Array<{ login: string }>
      if (orgs.some((o) => o.login === env.ALLOWED_GITHUB_ORG)) return
    }
  }

  throw new AllowlistError('not_in_org')
}
