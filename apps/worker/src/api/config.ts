import { Hono } from 'hono'
import type { Env } from '../env'
import type { ConfigResponse } from '@ctxlayer/shared'

export const configRoute = new Hono<{ Bindings: Env }>()

// Public, unauthenticated. The SPA calls this on the sign-in page to
// learn which IdPs are configured so it can hide buttons that would
// dead-end. An IdP is enabled when EITHER of its allowlists is set:
// hd OR per-email for Google; org OR per-user for GitHub.
configRoute.get('/', (c) => {
  const idps: Array<'google' | 'github'> = []
  if (c.env.ALLOWED_GOOGLE_HD?.length || c.env.ALLOWED_GOOGLE_EMAILS?.length) {
    idps.push('google')
  }
  if (c.env.ALLOWED_GITHUB_ORG?.length || c.env.ALLOWED_GITHUB_USERS?.length) {
    idps.push('github')
  }
  const body: ConfigResponse = {
    idps,
    publicBaseUrl: c.env.PUBLIC_BASE_URL
  }
  return c.json(body)
})
