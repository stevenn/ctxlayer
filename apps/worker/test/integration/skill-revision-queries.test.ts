import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env as WorkerEnv } from '../../src/env'
import { createSkill, skillRevisionQueries } from '../../src/db/queries/skills'

/**
 * Smoke for the skill-side `makeRevisionQueries` instantiation against
 * real D1. The machinery itself is shared with docs (pinned in depth by
 * revision-coalescing.test.ts); what this guards is the instantiation
 * config — parent/revision table names and the fk column — which the
 * type system can't check inside SQL strings.
 */

const testEnv = env as unknown as WorkerEnv

async function seedSkill(): Promise<string> {
  await testEnv.DB.prepare(
    `INSERT INTO users (id, email, name, idp, idp_sub, role, created_at)
     VALUES ('u-1', 'u1@example.com', NULL, 'github', 'gh-1', 'user', 0)`
  ).run()
  const row = await createSkill(testEnv, {
    title: 'Smoke skill',
    description: 'revision machinery smoke',
    createdBy: 'u-1'
  })
  return row.id
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM skill_revisions'),
    testEnv.DB.prepare('DELETE FROM skills'),
    testEnv.DB.prepare('DELETE FROM users')
  ])
})

describe('skillRevisionQueries (real D1)', () => {
  it('record → head → amend → seal round-trips through the skill tables', async () => {
    const skillId = await seedSkill()
    await skillRevisionQueries.record(testEnv, {
      parentId: skillId,
      revisionId: 'rev-1',
      authorId: 'u-1',
      r2Key: 'skills/x/revisions/rev-1.json',
      byteSize: 10,
      contentHash: 'hash-1',
      kind: 'autosave'
    })

    const head = await skillRevisionQueries.head(testEnv, skillId)
    expect(head).toMatchObject({ id: 'rev-1', authorId: 'u-1', kind: 'autosave' })

    await skillRevisionQueries.amend(testEnv, {
      parentId: skillId,
      revisionId: 'rev-1',
      byteSize: 20,
      contentHash: 'hash-2'
    })
    const amended = await skillRevisionQueries.get(testEnv, skillId, 'rev-1')
    expect(amended).toMatchObject({ byte_size: 20, content_hash: 'hash-2', kind: 'autosave' })

    await skillRevisionQueries.seal(testEnv, skillId, 'rev-1')
    expect((await skillRevisionQueries.head(testEnv, skillId))?.kind).toBe('explicit')
  })

  it('prunes surplus autosaves but spares the head and explicit rows', async () => {
    const skillId = await seedSkill()
    for (let i = 1; i <= 5; i++) {
      await skillRevisionQueries.record(testEnv, {
        parentId: skillId,
        revisionId: `rev-${i}`,
        authorId: 'u-1',
        r2Key: `skills/x/revisions/rev-${i}.json`,
        byteSize: i,
        contentHash: `hash-${i}`,
        kind: i === 1 ? 'explicit' : 'autosave'
      })
      // Distinct created_at ordering comes from insertion order; ids tiebreak.
    }
    const freed = await skillRevisionQueries.pruneAutosaves(testEnv, skillId, 2)
    expect(freed.sort()).toEqual(['skills/x/revisions/rev-2.json', 'skills/x/revisions/rev-3.json'])
    const remaining = await skillRevisionQueries.list(testEnv, skillId)
    expect(remaining.map((r) => r.id).sort()).toEqual(['rev-1', 'rev-4', 'rev-5'])
  })
})
