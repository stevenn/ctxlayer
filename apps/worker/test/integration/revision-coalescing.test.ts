import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  amendRevision,
  getHeadRevision,
  listRevisions,
  pruneAutosaveRevisions,
  recordRevision,
  sealRevision
} from '../../src/db/queries/docs'
import { decideRevision } from '../../src/db/revision-policy'
import type { Env as WorkerEnv } from '../../src/env'

/**
 * Proves the autosave-coalescing policy actually reduces *persisted*
 * revisions against a real D1 — the regression the whole change exists to
 * prevent (every 3s autosave used to INSERT its own row). Drives the same
 * getHeadRevision → decideRevision → record/amend/seal flow the PUT
 * /content handler uses, minus the R2 body write (recordRevision/amend
 * only touch D1, so the SQL is exercised faithfully).
 */

const testEnv = env as unknown as WorkerEnv
const NOW = 1_780_000_000

async function seedUser(id: string) {
  await testEnv.DB.prepare(
    `INSERT INTO users (id, email, name, idp, idp_sub, role, created_at)
     VALUES (?1, ?2, NULL, 'github', ?3, 'user', ?4)`
  )
    .bind(id, `${id}@example.com`, `sub-${id}`, NOW)
    .run()
}

async function seedDoc(id: string, ownerId: string) {
  await testEnv.DB.prepare(
    `INSERT INTO documents (id, title, slug, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)`
  )
    .bind(id, `Doc ${id}`, id, ownerId, NOW)
    .run()
}

async function revisionCount(docId: string): Promise<number> {
  const row = await testEnv.DB.prepare(
    `SELECT COUNT(*) AS n FROM doc_revisions WHERE doc_id = ?1`
  )
    .bind(docId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Mirror of the handler's save branch. `hash` stands in for the content
 * digest; a real `now` keeps the coalesce-window check consistent with the
 * created_at recordRevision stamps, so rapid saves in one test run fold
 * together (window-edge math is covered by the pure unit test).
 */
async function applySave(
  docId: string,
  userId: string,
  hash: string,
  explicit: boolean
): Promise<void> {
  const head = await getHeadRevision(testEnv, docId)
  const decision = decideRevision(head, {
    contentHash: hash,
    userId,
    explicit,
    now: Math.floor(Date.now() / 1000)
  })
  switch (decision.action) {
    case 'noop':
      return
    case 'seal':
      await sealRevision(testEnv, docId, decision.revisionId)
      return
    case 'amend':
      await amendRevision(testEnv, {
        docId,
        revisionId: decision.revisionId,
        byteSize: hash.length,
        contentHash: hash
      })
      return
    case 'new': {
      const revisionId = crypto.randomUUID().replace(/-/g, '')
      await recordRevision(testEnv, {
        docId,
        revisionId,
        authorId: userId,
        r2Key: `docs/${docId}/revisions/${revisionId}.json`,
        byteSize: hash.length,
        contentHash: hash,
        kind: decision.kind
      })
      return
    }
  }
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM doc_revisions'),
    testEnv.DB.prepare('DELETE FROM documents'),
    testEnv.DB.prepare('DELETE FROM users')
  ])
})

describe('autosave coalescing (persisted revision count)', () => {
  it('five rapid autosaves persist ONE row, holding the latest content', async () => {
    await seedUser('alice')
    await seedDoc('d1', 'alice')

    for (let i = 0; i < 5; i++) {
      await applySave('d1', 'alice', `hash-${i}`, false)
    }

    expect(await revisionCount('d1')).toBe(1)
    const head = await getHeadRevision(testEnv, 'd1')
    expect(head?.kind).toBe('autosave')
    expect(head?.contentHash).toBe('hash-4') // latest bytes survive — crash-insurance intact
  })

  it('an explicit save cuts a distinct checkpoint and freezes the autosave', async () => {
    await seedUser('alice')
    await seedDoc('d1', 'alice')

    await applySave('d1', 'alice', 'a', false) // autosave → row 1
    await applySave('d1', 'alice', 'b', false) // coalesces → still row 1
    expect(await revisionCount('d1')).toBe(1)

    await applySave('d1', 'alice', 'c', true) // explicit → row 2
    expect(await revisionCount('d1')).toBe(2)
    expect((await getHeadRevision(testEnv, 'd1'))?.kind).toBe('explicit')

    // The next autosave can't fold into a frozen explicit head → new row.
    await applySave('d1', 'alice', 'd', false)
    expect(await revisionCount('d1')).toBe(3)
    expect((await getHeadRevision(testEnv, 'd1'))?.kind).toBe('autosave')
  })

  it('identical content is a no-op; explicit-save-of-identical seals the autosave', async () => {
    await seedUser('alice')
    await seedDoc('d1', 'alice')

    await applySave('d1', 'alice', 'x', false) // row 1, autosave
    await applySave('d1', 'alice', 'x', false) // dedup → no-op
    expect(await revisionCount('d1')).toBe(1)

    await applySave('d1', 'alice', 'x', true) // identical + explicit → seal in place
    expect(await revisionCount('d1')).toBe(1)
    expect((await getHeadRevision(testEnv, 'd1'))?.kind).toBe('explicit')
  })

  it('a different author never coalesces into your autosave', async () => {
    await seedUser('alice')
    await seedUser('bob')
    await seedDoc('d1', 'alice')

    await applySave('d1', 'alice', 'a', false) // row 1
    await applySave('d1', 'bob', 'b', false) // different author → row 2
    expect(await revisionCount('d1')).toBe(2)
  })

  it('listRevisions surfaces the kind for the history UI', async () => {
    await seedUser('alice')
    await seedDoc('d1', 'alice')
    await applySave('d1', 'alice', 'a', false)
    await applySave('d1', 'alice', 'b', true)

    const revs = await listRevisions(testEnv, 'd1')
    expect(revs.map((r) => r.kind).sort()).toEqual(['autosave', 'explicit'])
  })
})

// Direct row insert with a controlled created_at + kind, so prune tests
// don't depend on the coalesce window's wall-clock behaviour.
async function insertRevision(
  docId: string,
  id: string,
  kind: 'autosave' | 'explicit',
  createdAt: number
) {
  await testEnv.DB.prepare(
    `INSERT INTO doc_revisions
       (id, doc_id, author_id, r2_key, byte_size, content_hash, created_at, kind)
     VALUES (?1, ?2, 'alice', ?3, 10, ?4, ?5, ?6)`
  )
    .bind(id, docId, `docs/${docId}/revisions/${id}.json`, `hash-${id}`, createdAt, kind)
    .run()
}

async function setHead(docId: string, revId: string) {
  await testEnv.DB.prepare(`UPDATE documents SET current_rev_id = ?1 WHERE id = ?2`)
    .bind(revId, docId)
    .run()
}

async function remainingIds(docId: string): Promise<string[]> {
  const res = await testEnv.DB.prepare(
    `SELECT id FROM doc_revisions WHERE doc_id = ?1 ORDER BY created_at`
  )
    .bind(docId)
    .all<{ id: string }>()
  return (res.results ?? []).map((r) => r.id)
}

describe('autosave retention prune', () => {
  beforeEach(async () => {
    await seedUser('alice')
    await seedDoc('d1', 'alice')
  })

  it('keeps the N most-recent autosaves, drops older ones, returns their R2 keys', async () => {
    await insertRevision('d1', 'a1', 'autosave', 100)
    await insertRevision('d1', 'a2', 'autosave', 200)
    await insertRevision('d1', 'a3', 'autosave', 300)
    await insertRevision('d1', 'a4', 'autosave', 400)
    await insertRevision('d1', 'a5', 'autosave', 500)
    await setHead('d1', 'a5')

    const freed = await pruneAutosaveRevisions(testEnv, 'd1', 2)

    expect(await remainingIds('d1')).toEqual(['a4', 'a5'])
    expect(freed.sort()).toEqual(
      ['a1', 'a2', 'a3'].map((id) => `docs/d1/revisions/${id}.json`)
    )
  })

  it('never prunes explicit checkpoints', async () => {
    await insertRevision('d1', 'e1', 'explicit', 100)
    await insertRevision('d1', 'a1', 'autosave', 200)
    await insertRevision('d1', 'a2', 'autosave', 300)
    await insertRevision('d1', 'a3', 'autosave', 400)
    await insertRevision('d1', 'e2', 'explicit', 500)
    await setHead('d1', 'e2')

    await pruneAutosaveRevisions(testEnv, 'd1', 1)

    // keep=1 → only a3 (newest autosave) retained; a1+a2 pruned; both
    // explicit checkpoints (e1, e2) untouched.
    expect(await remainingIds('d1')).toEqual(['e1', 'a3', 'e2'])
  })

  it('never prunes the live head, even when it is an old autosave', async () => {
    await insertRevision('d1', 'a1', 'autosave', 100)
    await insertRevision('d1', 'a2', 'autosave', 200)
    await insertRevision('d1', 'a3', 'autosave', 300)
    await insertRevision('d1', 'a4', 'autosave', 400)
    await setHead('d1', 'a1') // oldest is somehow the current head

    await pruneAutosaveRevisions(testEnv, 'd1', 2)

    // keep=2 → a3,a4 retained; a1 spared as head; only a2 dropped.
    expect(await remainingIds('d1')).toEqual(['a1', 'a3', 'a4'])
  })

  it('is a no-op (returns []) when under the cap', async () => {
    await insertRevision('d1', 'a1', 'autosave', 100)
    await insertRevision('d1', 'a2', 'autosave', 200)
    await setHead('d1', 'a2')

    expect(await pruneAutosaveRevisions(testEnv, 'd1', 20)).toEqual([])
    expect(await remainingIds('d1')).toEqual(['a1', 'a2'])
  })
})
