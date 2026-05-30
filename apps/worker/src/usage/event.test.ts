import { describe, expect, it } from 'vitest'
import { UsageEventMsg } from './event'

describe('UsageEventMsg', () => {
  const valid: UsageEventMsg = {
    id: 'abcd',
    ts: 1700000000,
    userId: 'u1',
    sessionId: 's1',
    upstreamId: null,
    tool: 'whoami',
    reqBytes: 0,
    respBytes: 12,
    reqTokens: 0,
    respTokens: 3,
    latencyMs: 5,
    status: 'ok',
    truncated: false
  }

  it('accepts a valid built-in (null upstream) message', () => {
    expect(UsageEventMsg.safeParse(valid).success).toBe(true)
  })

  it('accepts a proxied (string upstream) message', () => {
    const proxied = { ...valid, upstreamId: 'ups_123', tool: 'notion__notion-search' }
    expect(UsageEventMsg.safeParse(proxied).success).toBe(true)
  })

  it('rejects negative counts', () => {
    const bad = { ...valid, reqBytes: -1 }
    expect(UsageEventMsg.safeParse(bad).success).toBe(false)
  })

  it('rejects unknown status values', () => {
    const bad = { ...valid, status: 'unknown' }
    expect(UsageEventMsg.safeParse(bad).success).toBe(false)
  })

  it('defaults truncated to false when omitted (back-compat)', () => {
    const { truncated: _omit, ...withoutTruncated } = valid
    const parsed = UsageEventMsg.safeParse(withoutTruncated)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.truncated).toBe(false)
  })

  it('accepts an explicit truncated flag', () => {
    const parsed = UsageEventMsg.safeParse({ ...valid, truncated: true })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.truncated).toBe(true)
  })
})
