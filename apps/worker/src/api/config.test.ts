import { describe, expect, it } from 'vitest'
import type { ConfigResponse } from '@ctxlayer/shared'
import type { Env } from '../env'
import { configRoute } from './config'

function fakeEnv(over: Partial<Env> = {}): Env {
  return {
    PUBLIC_BASE_URL: 'https://ctx.test',
    ALLOWED_GOOGLE_HD: '',
    ALLOWED_GOOGLE_EMAILS: '',
    ALLOWED_GITHUB_ORG: '',
    ALLOWED_GITHUB_USERS: '',
    ...over
  } as unknown as Env
}

async function getConfig(env: Env): Promise<ConfigResponse> {
  const res = await configRoute.request('/', {}, env)
  expect(res.status).toBe(200)
  return (await res.json()) as ConfigResponse
}

describe('/api/config', () => {
  it('reports accessSso (and no IdPs) on an Access-only deploy', async () => {
    // The yukitools shape: every IdP allowlist empty, Access is the gate.
    // Without accessSso the sign-in page dead-ends after sign-out.
    const body = await getConfig(
      fakeEnv({ CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud-tag' })
    )
    expect(body.accessSso).toBe(true)
    expect(body.idps).toEqual([])
  })

  it('reports accessSso false when Access trust is not configured', async () => {
    const body = await getConfig(fakeEnv({ ALLOWED_GITHUB_ORG: 'my-org' }))
    expect(body.accessSso).toBe(false)
    expect(body.idps).toEqual(['github'])
  })

  it('needs BOTH Access vars — team domain alone is not trust', async () => {
    const body = await getConfig(fakeEnv({ CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' }))
    expect(body.accessSso).toBe(false)
  })
})
