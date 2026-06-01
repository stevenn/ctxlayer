import { describe, it, expect } from 'vitest'
import { UpstreamUrl, GitBaseUrl } from '@ctxlayer/shared'

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

  it('rejects our own Cloudflare hosts (self-loop guard)', () => {
    expect(schema.safeParse('https://ctxlayer.acme.workers.dev/mcp').success).toBe(false)
    expect(schema.safeParse('https://foo.cloudflareworkers.com').success).toBe(false)
  })

  it('is not fooled by userinfo before the real host', () => {
    expect(schema.safeParse('https://workers.dev@evil.example.com').success).toBe(true)
    expect(schema.safeParse('https://evil.example.com@ctxlayer.acme.workers.dev').success).toBe(
      false
    )
  })
})
