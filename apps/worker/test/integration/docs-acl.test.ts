import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  canEditDoc,
  canLockDoc,
  canShareDoc
} from '../../src/db/queries/docs'
import type { Env as WorkerEnv } from '../../src/env'

/**
 * Doc-ACL gate behaviour against a real D1. canEditDoc / canShareDoc /
 * canLockDoc encode the lock policy, ownership, editor-share, and
 * admin role in one SQL predicate each — easy to regress, so this
 * pins the matrix.
 */

const testEnv = env as unknown as WorkerEnv
const NOW = 1_780_000_000

async function seedUser(id: string, role: 'user' | 'admin' = 'user') {
  await testEnv.DB.prepare(
    `INSERT INTO users (id, email, name, idp, idp_sub, role, created_at)
     VALUES (?1, ?2, NULL, 'github', ?3, ?4, ?5)`
  )
    .bind(id, `${id}@example.com`, `sub-${id}`, role, NOW)
    .run()
}

async function seedDoc(opts: {
  id: string
  ownerId: string
  locked?: boolean
  deleted?: boolean
}) {
  const lockedAt = opts.locked ? NOW : null
  const lockedBy = opts.locked ? opts.ownerId : null
  const deletedAt = opts.deleted ? NOW : null
  await testEnv.DB.prepare(
    `INSERT INTO documents
       (id, title, slug, created_by, created_at, updated_at,
        deleted_at, locked_at, locked_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8)`
  )
    .bind(opts.id, `Doc ${opts.id}`, opts.id, opts.ownerId, NOW, deletedAt, lockedAt, lockedBy)
    .run()
}

async function shareDocWithUser(docId: string, userId: string) {
  await testEnv.DB.prepare(
    `INSERT INTO doc_editors (doc_id, scope_kind, scope_id, granted_by, created_at)
     VALUES (?1, 'user', ?2, ?2, ?3)`
  )
    .bind(docId, userId, NOW)
    .run()
}

async function shareDocWithEveryone(docId: string, grantedBy: string) {
  await testEnv.DB.prepare(
    `INSERT INTO doc_editors (doc_id, scope_kind, scope_id, granted_by, created_at)
     VALUES (?1, 'everyone', '', ?2, ?3)`
  )
    .bind(docId, grantedBy, NOW)
    .run()
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM doc_editors'),
    testEnv.DB.prepare('DELETE FROM documents'),
    testEnv.DB.prepare('DELETE FROM users')
  ])
})

describe('canEditDoc', () => {
  it('owner can edit', async () => {
    await seedUser('alice')
    await seedDoc({ id: 'd1', ownerId: 'alice' })
    expect(await canEditDoc(testEnv, 'alice', 'd1')).toBe(true)
  })

  it('non-owner without share cannot edit', async () => {
    await seedUser('alice')
    await seedUser('bob')
    await seedDoc({ id: 'd1', ownerId: 'alice' })
    expect(await canEditDoc(testEnv, 'bob', 'd1')).toBe(false)
  })

  it('user-scope editor share grants edit', async () => {
    await seedUser('alice')
    await seedUser('bob')
    await seedDoc({ id: 'd1', ownerId: 'alice' })
    await shareDocWithUser('d1', 'bob')
    expect(await canEditDoc(testEnv, 'bob', 'd1')).toBe(true)
  })

  it('everyone-scope share grants edit to any signed-in user', async () => {
    await seedUser('alice')
    await seedUser('charlie')
    await seedDoc({ id: 'd1', ownerId: 'alice' })
    await shareDocWithEveryone('d1', 'alice')
    expect(await canEditDoc(testEnv, 'charlie', 'd1')).toBe(true)
  })

  it('admin can always edit', async () => {
    await seedUser('alice')
    await seedUser('admin1', 'admin')
    await seedDoc({ id: 'd1', ownerId: 'alice' })
    expect(await canEditDoc(testEnv, 'admin1', 'd1')).toBe(true)
  })

  it('lock blocks edit even for owner and admin', async () => {
    await seedUser('alice')
    await seedUser('admin1', 'admin')
    await seedDoc({ id: 'd1', ownerId: 'alice', locked: true })
    expect(await canEditDoc(testEnv, 'alice', 'd1')).toBe(false)
    expect(await canEditDoc(testEnv, 'admin1', 'd1')).toBe(false)
  })

  it('deleted doc cannot be edited by anyone', async () => {
    await seedUser('alice')
    await seedUser('admin1', 'admin')
    await seedDoc({ id: 'd1', ownerId: 'alice', deleted: true })
    expect(await canEditDoc(testEnv, 'alice', 'd1')).toBe(false)
    expect(await canEditDoc(testEnv, 'admin1', 'd1')).toBe(false)
  })

  it('missing doc returns false', async () => {
    await seedUser('alice')
    expect(await canEditDoc(testEnv, 'alice', 'does-not-exist')).toBe(false)
  })
})

describe('canShareDoc', () => {
  it('owner can share, granted editor cannot', async () => {
    await seedUser('alice')
    await seedUser('bob')
    await seedDoc({ id: 'd1', ownerId: 'alice' })
    await shareDocWithUser('d1', 'bob')
    expect(await canShareDoc(testEnv, 'alice', 'd1')).toBe(true)
    expect(await canShareDoc(testEnv, 'bob', 'd1')).toBe(false)
  })

  it('admin can share', async () => {
    await seedUser('alice')
    await seedUser('admin1', 'admin')
    await seedDoc({ id: 'd1', ownerId: 'alice' })
    expect(await canShareDoc(testEnv, 'admin1', 'd1')).toBe(true)
  })

  it('lock does NOT block sharing (deliberate policy)', async () => {
    // Per the lock design: content is frozen, but admins/owner must
    // still be able to revoke access on a locked doc.
    await seedUser('alice')
    await seedDoc({ id: 'd1', ownerId: 'alice', locked: true })
    expect(await canShareDoc(testEnv, 'alice', 'd1')).toBe(true)
  })
})

describe('canLockDoc', () => {
  it('owner and admin can lock; granted editor cannot', async () => {
    await seedUser('alice')
    await seedUser('bob')
    await seedUser('admin1', 'admin')
    await seedDoc({ id: 'd1', ownerId: 'alice' })
    await shareDocWithUser('d1', 'bob')
    expect(await canLockDoc(testEnv, 'alice', 'd1')).toBe(true)
    expect(await canLockDoc(testEnv, 'admin1', 'd1')).toBe(true)
    expect(await canLockDoc(testEnv, 'bob', 'd1')).toBe(false)
  })
})
