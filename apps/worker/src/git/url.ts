/**
 * Base-URL resolution for git providers. The admin REST handler validates
 * the configured base URL with the `GitBaseUrl` Zod refine (https-only, not
 * a workers host); providers re-assert https at the dial site via
 * `util/safe-fetch.ts`. This module derives the API + web hosts per provider.
 */

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

/**
 * GitHub REST API base. NULL ⇒ public github.com (api.github.com).
 * For GitHub Enterprise the configured base is the instance root; its
 * API lives under `/api/v3`.
 */
export function githubApiBase(baseUrl: string | null): string {
  if (!baseUrl) return 'https://api.github.com'
  const root = stripTrailingSlash(baseUrl)
  return /\/api\/v3$/.test(root) ? root : `${root}/api/v3`
}

/** GitHub web base for building file deep-links (blob URLs). */
export function githubWebBase(baseUrl: string | null): string {
  if (!baseUrl) return 'https://github.com'
  // Enterprise instance root doubles as the web host.
  return stripTrailingSlash(baseUrl).replace(/\/api\/v3$/, '')
}

/**
 * GitLab REST v4 base. NULL ⇒ public gitlab.com. For self-managed the
 * configured base is the instance root; its API lives under `/api/v4`.
 */
export function gitlabApiBase(baseUrl: string | null): string {
  if (!baseUrl) return 'https://gitlab.com/api/v4'
  const root = stripTrailingSlash(baseUrl)
  return /\/api\/v4$/.test(root) ? root : `${root}/api/v4`
}

/** GitLab web base for building file deep-links + the MR redirect. */
export function gitlabWebBase(baseUrl: string | null): string {
  if (!baseUrl) return 'https://gitlab.com'
  return stripTrailingSlash(baseUrl).replace(/\/api\/v4$/, '')
}

/**
 * Azure DevOps host root. NULL ⇒ public dev.azure.com (the org/project/repo
 * are appended by the provider, since ADO carries them in the path). A custom
 * base is an on-prem Azure DevOps Server collection root.
 */
export function azureBase(baseUrl: string | null): string {
  return baseUrl ? stripTrailingSlash(baseUrl) : 'https://dev.azure.com'
}
