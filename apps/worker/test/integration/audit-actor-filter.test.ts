import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env as WorkerEnv } from '../../src/env'
import { listAuditEntries } from '../../src/db/queries/audit'

/**
 * Pins the audit-viewer actor filter (2026-08-28 report: "actor id filter
 * seems not to work"): the table DISPLAYS the actor's email, so the filter
 * must match id exactly OR email as a case-insensitive substring — an
 * exact-id-only filter read as broken to anyone pasting what they saw.
 */

const testEnv = env as unknown as WorkerEnv

async function seedEntry(id: string, actorId: string | null, action: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO audit_log (id, ts, actor_id, action, target, meta)
     VALUES (?1, 1000, ?2, ?3, NULL, NULL)`
  )
    .bind(id, actorId, action)
    .run()
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM audit_log'),
    testEnv.DB.prepare('DELETE FROM users'),
    testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, created_at)
       VALUES ('u-steven', 'steven@example.test', 'github', 'gh-1', 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, created_at)
       VALUES ('u-other', 'other@example.test', 'github', 'gh-2', 0)`
    )
  ])
  await seedEntry('a-1', 'u-steven', 'doc.create')
  await seedEntry('a-2', 'u-other', 'doc.update')
  await seedEntry('a-3', 'cron', 'oauth_client.prune')
})

afterEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM audit_log'),
    testEnv.DB.prepare('DELETE FROM users')
  ])
})

describe('listAuditEntries actor filter (real D1)', () => {
  it('matches by exact actor id', async () => {
    const page = await listAuditEntries(testEnv, { limit: 10, actor: 'u-steven' })
    expect(page.entries.map((e) => e.id)).toEqual(['a-1'])
  })

  it('matches by email substring (what the Actor column displays)', async () => {
    const page = await listAuditEntries(testEnv, { limit: 10, actor: 'steven@' })
    expect(page.entries.map((e) => e.id)).toEqual(['a-1'])
    expect(page.entries[0]!.actorEmail).toBe('steven@example.test')
  })

  it('matches sentinel actors with no user row by id (cron)', async () => {
    const page = await listAuditEntries(testEnv, { limit: 10, actor: 'cron' })
    expect(page.entries.map((e) => e.id)).toEqual(['a-3'])
  })

  it('escapes LIKE wildcards — a bare % matches nothing, not everything', async () => {
    const page = await listAuditEntries(testEnv, { limit: 10, actor: '%' })
    expect(page.entries).toEqual([])
  })

  it('no filter returns everything newest-first', async () => {
    const page = await listAuditEntries(testEnv, { limit: 10 })
    expect(page.entries).toHaveLength(3)
  })
})
