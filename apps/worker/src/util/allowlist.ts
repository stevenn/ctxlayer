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

export function enforceGoogleAllowlist(profile: GoogleProfile, env: Env): void {
  if (!env.ALLOWED_GOOGLE_HD) throw new AllowlistError('google_disabled')
  if (profile.hd !== env.ALLOWED_GOOGLE_HD) throw new AllowlistError('wrong_domain')
}

export async function enforceGithubAllowlist(
  accessToken: string,
  env: Env
): Promise<void> {
  if (!env.ALLOWED_GITHUB_ORG) throw new AllowlistError('github_disabled')
  const res = await fetch('https://api.github.com/user/orgs', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ctxlayer'
    }
  })
  if (!res.ok) throw new AllowlistError('not_in_org')
  const orgs = (await res.json()) as Array<{ login: string }>
  if (!orgs.some((o) => o.login === env.ALLOWED_GITHUB_ORG)) {
    throw new AllowlistError('not_in_org')
  }
}
