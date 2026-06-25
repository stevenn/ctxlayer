import { Hono } from 'hono'
import type { Env } from '../env'
import type { ConfigResponse } from '@ctxlayer/shared'
import { parseAccessPolicy } from '../auth/admission'

export const configRoute = new Hono<{ Bindings: Env }>()

// Public, unauthenticated. The SPA calls this on the sign-in page to learn
// which IdPs to offer + the admission policy (so it can show a join-code
// input under `invite`).
//
// Which IdPs to show:
//   - open_domain (legacy): an IdP is shown when its allowlist gate is set
//     (hd OR per-email for Google; org OR per-user for GitHub) — admission is
//     the allowlist, so no allowlist = dead-end = hidden.
//   - request / invite: admission comes from invites/codes (and optionally
//     the domain pre-filter), so an IdP is shown whenever its client
//     credentials are configured, even with no allowlist.
configRoute.get('/', (c) => {
  const policy = parseAccessPolicy(c.env)

  const googleAllow = !!(c.env.ALLOWED_GOOGLE_HD?.length || c.env.ALLOWED_GOOGLE_EMAILS?.length)
  const githubAllow = !!(c.env.ALLOWED_GITHUB_ORG?.length || c.env.ALLOWED_GITHUB_USERS?.length)
  const googleCreds = !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET)
  const githubCreds = !!(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET)

  const idps: Array<'google' | 'github'> = []
  if (policy === 'open_domain' ? googleAllow : googleCreds) idps.push('google')
  if (policy === 'open_domain' ? githubAllow : githubCreds) idps.push('github')

  const body: ConfigResponse = {
    idps,
    publicBaseUrl: c.env.PUBLIC_BASE_URL,
    // Dedicated MCP host when configured (Access deployments front the same
    // Worker at mcp.<tenant>); otherwise the MCP surface is the same host.
    mcpBaseUrl: c.env.MCP_PUBLIC_URL || c.env.PUBLIC_BASE_URL,
    accessPolicy: policy
  }
  return c.json(body)
})
