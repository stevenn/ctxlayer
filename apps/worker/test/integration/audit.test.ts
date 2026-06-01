import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { listAuditEntries } from '../../src/db/queries/audit'
import { audit } from '../../src/audit/log'
import type { Env as WorkerEnv } from '../../src/env'

/**
 * Integration coverage for the audit-log read path that backs
 * /app/admin/audit. Verifies cursor pagination, action-prefix +
 * actor filters, the actor-email LEFT JOIN (so log rows survive
 * after a user is deleted), and that `nextBefore` is null at the
 * tail of a result.
 */

const testEnv = env as unknown as WorkerEnv
const BASE_TS = 1_780_000_000

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM audit_log'),
    testEnv.DB.prepare('DELETE FROM users')
  ])
})

async function seedUser(id: string) {
  await testEnv.DB.prepare(
    `INSERT INTO users (id, email, name, idp, idp_sub, role, created_at)
     VALUES (?1, ?2, NULL, 'github', ?3, 'user', ?4)`
  )
    .bind(id, `${id}@example.com`, `sub-${id}`, BASE_TS)
    .run()
}

async function seedAudit(action: string, actorId: string | null, ts: number) {
  // Use a raw INSERT (not the audit() helper) so we control ts —
  // the helper stamps Date.now()/1000 which makes ordering tests
  // flaky on a multi-row insert.
  await testEnv.DB.prepare(
    `INSERT INTO audit_log (id, ts, actor_id, action, target, meta)
     VALUES (?1, ?2, ?3, ?4, NULL, NULL)`
  )
    .bind(crypto.randomUUID().replace(/-/g, ''), ts, actorId, action)
    .run()
}

describe('listAuditEntries', () => {
  it('paginates newest-first with cursor on ts', async () => {
    await seedUser('alice')
    // Insert 12 rows at distinct timestamps so the cursor is well-defined.
    for (let i = 0; i < 12; i++) {
      await seedAudit('user.promote', 'alice', BASE_TS + i)
    }

    const page1 = await listAuditEntries(testEnv, { limit: 5 })
    expect(page1.entries).toHaveLength(5)
    expect(page1.entries[0]!.ts).toBe(BASE_TS + 11)
    expect(page1.entries[4]!.ts).toBe(BASE_TS + 7)
    expect(page1.nextBefore).toBe(BASE_TS + 7)

    const page2 = await listAuditEntries(testEnv, { limit: 5, before: page1.nextBefore! })
    expect(page2.entries[0]!.ts).toBe(BASE_TS + 6)
    expect(page2.entries[4]!.ts).toBe(BASE_TS + 2)
    expect(page2.nextBefore).toBe(BASE_TS + 2)

    const page3 = await listAuditEntries(testEnv, { limit: 5, before: page2.nextBefore! })
    expect(page3.entries).toHaveLength(2)
    // Tail page: fewer than `limit` returned → nextBefore is null.
    expect(page3.nextBefore).toBeNull()
  })

  it('actionPrefix filter is a LIKE-prefix match', async () => {
    await seedUser('alice')
    await seedAudit('user.promote', 'alice', BASE_TS)
    await seedAudit('user.demote', 'alice', BASE_TS + 1)
    await seedAudit('doc.lock', 'alice', BASE_TS + 2)
    await seedAudit('upstream.create', 'alice', BASE_TS + 3)

    const userOnly = await listAuditEntries(testEnv, { limit: 10, actionPrefix: 'user.' })
    expect(userOnly.entries.map((e) => e.action).sort()).toEqual(['user.demote', 'user.promote'])
  })

  it('actorId filter is an exact match', async () => {
    await seedUser('alice')
    await seedUser('bob')
    await seedAudit('doc.lock', 'alice', BASE_TS)
    await seedAudit('doc.unlock', 'bob', BASE_TS + 1)
    await seedAudit('doc.lock', 'alice', BASE_TS + 2)

    const aliceOnly = await listAuditEntries(testEnv, { limit: 10, actorId: 'alice' })
    expect(aliceOnly.entries).toHaveLength(2)
    expect(aliceOnly.entries.every((e) => e.actorId === 'alice')).toBe(true)
  })

  it('LEFT JOIN keeps rows visible after the actor is deleted', async () => {
    await seedUser('ghost')
    await seedAudit('user.demote', 'ghost', BASE_TS)
    await testEnv.DB.prepare('DELETE FROM users WHERE id = ?1').bind('ghost').run()

    const page = await listAuditEntries(testEnv, { limit: 10 })
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]!.actorId).toBe('ghost')
    expect(page.entries[0]!.actorEmail).toBeNull()
  })

  it('audit() helper round-trips through listAuditEntries', async () => {
    await seedUser('alice')
    await audit(testEnv, {
      actorId: 'alice',
      action: 'doc.lock',
      target: 'doc-42',
      meta: { from: 'unlocked', to: 'locked' }
    })

    const page = await listAuditEntries(testEnv, { limit: 10 })
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]!.action).toBe('doc.lock')
    expect(page.entries[0]!.target).toBe('doc-42')
    expect(page.entries[0]!.actorEmail).toBe('alice@example.com')
    expect(page.entries[0]!.meta).toEqual({ from: 'unlocked', to: 'locked' })
  })
})
