import { describe, it, expect, vi } from 'vitest'
import { ensureOutboxTable, stageUsageRow, drainOutbox, USAGE_DRAIN_BATCH } from './outbox'
import { buildUsageMsg } from './record'
import { UsageEventMsg } from './event'

/**
 * Minimal in-memory stand-in for the DO's `SqlStorage`, honouring only
 * the four statements `outbox.ts` issues: CREATE, INSERT (auto seq),
 * SELECT … ORDER BY seq LIMIT ?, DELETE … WHERE seq <= ?, COUNT(*).
 * Enough to exercise the seq/limit/delete semantics without real SQLite.
 */
function fakeSql() {
  let rows: Array<{ seq: number; msg: string }> = []
  let nextSeq = 1
  const result = (arr: unknown[]) => ({ toArray: () => arr, one: () => arr[0] })
  const sql = {
    exec(query: string, ...binds: unknown[]) {
      if (query.startsWith('CREATE TABLE')) return result([])
      if (query.startsWith('INSERT INTO usage_outbox')) {
        rows.push({ seq: nextSeq++, msg: binds[0] as string })
        return result([])
      }
      if (query.startsWith('SELECT seq, msg')) {
        const limit = binds[0] as number
        const out = [...rows].sort((a, b) => a.seq - b.seq).slice(0, limit)
        return result(out)
      }
      if (query.startsWith('DELETE FROM usage_outbox')) {
        const maxSeq = binds[0] as number
        rows = rows.filter((r) => r.seq > maxSeq)
        return result([])
      }
      if (query.startsWith('SELECT COUNT(*)')) return result([{ n: rows.length }])
      throw new Error(`unexpected query: ${query}`)
    }
  }
  return { sql: sql as unknown as SqlStorage, peek: () => rows, stage: () => nextSeq }
}

function fakeQueue(sendBatch: (b: unknown[]) => Promise<void>) {
  return { send: vi.fn(), sendBatch: vi.fn(sendBatch) } as unknown as Queue & {
    sendBatch: ReturnType<typeof vi.fn>
  }
}

const msg = (tool: string) =>
  buildUsageMsg({
    userId: 'u1',
    sessionId: 's1',
    upstreamId: null,
    tool,
    reqJson: '{}',
    respJson: '{}',
    latencyMs: 1,
    status: 'ok'
  })

describe('drainOutbox', () => {
  it('sends staged rows then deletes only what was sent', async () => {
    const { sql, peek } = fakeSql()
    ensureOutboxTable(sql)
    stageUsageRow(sql, msg('a'))
    stageUsageRow(sql, msg('b'))
    stageUsageRow(sql, msg('c'))
    const q = fakeQueue(async () => {})

    const res = await drainOutbox(sql, q)

    expect(res).toEqual({ sent: 3, remaining: 0 })
    expect(q.sendBatch).toHaveBeenCalledTimes(1)
    const batch = (q.sendBatch.mock.calls[0]?.[0] ?? []) as Array<{ body: { tool: string } }>
    expect(batch.map((m) => m.body.tool)).toEqual(['a', 'b', 'c'])
    expect(peek()).toHaveLength(0)
  })

  it('is a no-op on an empty outbox', async () => {
    const { sql } = fakeSql()
    ensureOutboxTable(sql)
    const q = fakeQueue(async () => {})
    expect(await drainOutbox(sql, q)).toEqual({ sent: 0, remaining: 0 })
    expect(q.sendBatch).not.toHaveBeenCalled()
  })

  it('drains a backlog across passes, capped at USAGE_DRAIN_BATCH', async () => {
    const { sql } = fakeSql()
    ensureOutboxTable(sql)
    const total = USAGE_DRAIN_BATCH + 50
    for (let i = 0; i < total; i++) stageUsageRow(sql, msg(`t${i}`))
    const q = fakeQueue(async () => {})

    const first = await drainOutbox(sql, q)
    expect(first).toEqual({ sent: USAGE_DRAIN_BATCH, remaining: 50 })
    const second = await drainOutbox(sql, q)
    expect(second).toEqual({ sent: 50, remaining: 0 })
  })

  it('leaves rows staged when the queue send fails (at-least-once)', async () => {
    const { sql, peek } = fakeSql()
    ensureOutboxTable(sql)
    stageUsageRow(sql, msg('a'))
    stageUsageRow(sql, msg('b'))
    const q = fakeQueue(async () => {
      throw new Error('queue down')
    })

    await expect(drainOutbox(sql, q)).rejects.toThrow('queue down')
    expect(peek()).toHaveLength(2)
  })

  it('keeps a row appended mid-send for the next drain', async () => {
    const { sql, peek } = fakeSql()
    ensureOutboxTable(sql)
    stageUsageRow(sql, msg('a'))
    // Simulate a concurrent tool call staging while sendBatch is in flight:
    // its higher seq must survive the post-send DELETE.
    const q = fakeQueue(async () => {
      stageUsageRow(sql, msg('late'))
    })

    const res = await drainOutbox(sql, q)
    expect(res.sent).toBe(1)
    expect(res.remaining).toBe(1)
    expect(peek().map((r) => JSON.parse(r.msg).tool)).toEqual(['late'])
  })
})

describe('buildUsageMsg', () => {
  it('produces a schema-valid message with computed byte/token counts', () => {
    const m = buildUsageMsg({
      userId: 'u1',
      sessionId: 's1',
      upstreamId: 'up1',
      tool: 'linear__list_issues',
      reqJson: '{"q":"hello"}',
      respJson: 'a response body',
      latencyMs: 42,
      status: 'ok',
      truncated: true
    })
    expect(() => UsageEventMsg.parse(m)).not.toThrow()
    expect(m.reqBytes).toBeGreaterThan(0)
    expect(m.respTokens).toBeGreaterThan(0)
    expect(m.truncated).toBe(true)
    expect(m.id).toMatch(/^[0-9a-f]{32}$/)
  })
})
