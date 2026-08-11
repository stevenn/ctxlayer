import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env as WorkerEnv } from '../../src/env'
import {
  listCachedTools,
  replaceCachedTools,
  type CatalogueTool
} from '../../src/db/queries/upstream-tools'

/**
 * Pins the catalogue shrink-guard (2026-08-11 Datadog incident): a
 * background refresh that got a degraded `tools/list` must not wipe or
 * collapse the org-global catalogue; the admin path forces through.
 */

const testEnv = env as unknown as WorkerEnv
const UPS = 'ups-guard'

const tools = (names: string[]): CatalogueTool[] =>
  names.map((n) => ({ toolName: n, description: `does ${n}`, inputSchema: {} }))

const SIX = tools(['a', 'b', 'c', 'd', 'e', 'f'])

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM upstream_tools'),
    testEnv.DB.prepare('DELETE FROM upstream_servers'),
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('${UPS}', 'up-guard', 'Guard', 'streamable_http', 'https://g.test/mcp', 'none', '{}', 0, 0)`
    )
  ])
})

describe('replaceCachedTools shrink-guard (real D1)', () => {
  it('accepts the first write into an empty cache', async () => {
    const res = await replaceCachedTools(testEnv, UPS, SIX)
    expect(res.rejectedShrink).toBeUndefined()
    expect(await listCachedTools(testEnv, UPS)).toHaveLength(6)
  })

  it('rejects a collapse below a third, keeping the prior rows', async () => {
    await replaceCachedTools(testEnv, UPS, SIX)
    const res = await replaceCachedTools(testEnv, UPS, tools(['a']))
    expect(res.rejectedShrink).toEqual({ prior: 6, incoming: 1 })
    expect((await listCachedTools(testEnv, UPS)).map((t) => t.tool_name)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f'
    ])
  })

  it('rejects an empty list wiping any non-empty cache', async () => {
    await replaceCachedTools(testEnv, UPS, tools(['a', 'b']))
    const res = await replaceCachedTools(testEnv, UPS, [])
    expect(res.rejectedShrink).toEqual({ prior: 2, incoming: 0 })
    expect(await listCachedTools(testEnv, UPS)).toHaveLength(2)
  })

  it('accepts a moderate shrink (a third or more survives)', async () => {
    await replaceCachedTools(testEnv, UPS, SIX)
    const res = await replaceCachedTools(testEnv, UPS, tools(['a', 'b', 'c']))
    expect(res.rejectedShrink).toBeUndefined()
    expect(await listCachedTools(testEnv, UPS)).toHaveLength(3)
  })

  it('force applies a genuine large removal (the admin path)', async () => {
    await replaceCachedTools(testEnv, UPS, SIX)
    const res = await replaceCachedTools(testEnv, UPS, tools(['a']), { force: true })
    expect(res.rejectedShrink).toBeUndefined()
    expect(await listCachedTools(testEnv, UPS)).toHaveLength(1)
  })

  it('does not let a rejection refresh cached_at (stale stays stale, next dial retries)', async () => {
    await replaceCachedTools(testEnv, UPS, SIX)
    const before = (await listCachedTools(testEnv, UPS))[0]?.cached_at
    await replaceCachedTools(testEnv, UPS, [])
    const after = (await listCachedTools(testEnv, UPS))[0]?.cached_at
    expect(after).toBe(before)
  })
})
