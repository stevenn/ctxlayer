import { describe, expect, it } from 'vitest'
import { CLIENT_NAME_MAX, UsageEventMsg, cleanClientName } from './event'
import { buildUsageMsg } from './record'

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

describe('lane fields', () => {
  const base = {
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
    status: 'ok'
  }

  it('a message enqueued before lane tracking still parses', () => {
    const parsed = UsageEventMsg.parse(base)
    expect(parsed.lane ?? null).toBeNull()
  })

  it('accepts the known lanes and rejects anything else', () => {
    expect(UsageEventMsg.safeParse({ ...base, lane: 'session' }).success).toBe(true)
    expect(UsageEventMsg.safeParse({ ...base, lane: 'stateless' }).success).toBe(true)
    expect(UsageEventMsg.safeParse({ ...base, lane: 'sse' }).success).toBe(false)
  })

  it('cleanClientName trims, collapses, caps and nulls empties', () => {
    expect(cleanClientName('  claude-ai  ')).toBe('claude-ai')
    expect(cleanClientName('a\n\tb')).toBe('a b')
    expect(cleanClientName('x'.repeat(500))).toHaveLength(CLIENT_NAME_MAX)
    expect(cleanClientName('   ')).toBeNull()
    expect(cleanClientName(undefined)).toBeNull()
    expect(cleanClientName(42)).toBeNull()
  })

  it('buildUsageMsg carries the origin, and omits it cleanly when unknown', () => {
    const args = {
      userId: 'u1',
      sessionId: 's1',
      upstreamId: null,
      tool: 'whoami',
      reqJson: '{}',
      respJson: '{}',
      latencyMs: 1,
      status: 'ok' as const
    }
    expect(
      buildUsageMsg({
        ...args,
        origin: { lane: 'session', protocolVersion: '2025-11-25', clientName: ' claude-code ' }
      })
    ).toMatchObject({ lane: 'session', protocolVersion: '2025-11-25', clientName: 'claude-code' })
    expect(buildUsageMsg(args)).toMatchObject({
      lane: null,
      protocolVersion: null,
      clientName: null
    })
  })
})
