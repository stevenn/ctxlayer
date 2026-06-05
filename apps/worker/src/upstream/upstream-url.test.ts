import { describe, it, expect } from 'vitest'
import { UpstreamUrl, GitBaseUrl, isSameOrigin } from '@ctxlayer/shared'

// Both validators share `url-trust.ts`; assert the trust-boundary rules
// hold identically so the two can't drift apart again.
describe.each([
  ['UpstreamUrl', UpstreamUrl],
  ['GitBaseUrl', GitBaseUrl]
])('%s trust boundary', (_name, schema) => {
  it('accepts https hosts', () => {
    expect(schema.safeParse('https://mcp.example.com/sse').success).toBe(true)
  })

  it('accepts http only for loopback (dev)', () => {
    expect(schema.safeParse('http://localhost:8080/mcp').success).toBe(true)
    expect(schema.safeParse('http://127.0.0.1:3000').success).toBe(true)
    expect(schema.safeParse('http://mcp.example.com').success).toBe(false)
  })

  it('accepts other Cloudflare-hosted MCPs (no blanket workers.dev block)', () => {
    // The old TLD-wide reject wrongly blocked third-party workers. The
    // self-loop guard now lives in the admin REST handler (isSameOrigin
    // vs PUBLIC_BASE_URL), so the schema must accept these.
    expect(schema.safeParse('https://yuki-ia-mcp.dizzydata-bv.workers.dev/mcp').success).toBe(true)
    expect(schema.safeParse('https://foo.cloudflareworkers.com').success).toBe(true)
  })
})

describe('isSameOrigin (self-loop guard)', () => {
  const base = 'https://ctxlayer.acme.workers.dev'

  it('matches the same host, default https port treated as :443', () => {
    expect(isSameOrigin('https://ctxlayer.acme.workers.dev/mcp', base)).toBe(true)
    expect(isSameOrigin('https://ctxlayer.acme.workers.dev:443/mcp', base)).toBe(true)
  })

  it('does not match a different Cloudflare-hosted worker', () => {
    expect(isSameOrigin('https://yuki-ia-mcp.dizzydata-bv.workers.dev/mcp', base)).toBe(false)
  })

  it('distinguishes localhost ports (dev server vs a dev upstream)', () => {
    const dev = 'https://localhost:8787'
    expect(isSameOrigin('http://localhost:8080/mcp', dev)).toBe(false)
    expect(isSameOrigin('https://localhost:8787/mcp', dev)).toBe(true)
  })

  it('is not fooled by userinfo before the real host', () => {
    // The authority is what follows the last '@'.
    expect(isSameOrigin('https://evil.example.com@ctxlayer.acme.workers.dev/mcp', base)).toBe(true)
    expect(isSameOrigin('https://ctxlayer.acme.workers.dev@evil.example.com', base)).toBe(false)
  })
})
