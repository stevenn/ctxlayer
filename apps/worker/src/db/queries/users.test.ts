import { describe, expect, it } from 'vitest'
import { deleteUser } from './users'
import type { Env } from '../../env'

/**
 * Fake D1 that records the SQL of every statement handed to `batch()`. Lets us
 * lock in deleteUser's FK-cleanup invariant without a real database: nullable
 * authorship is de-attributed, the NOT-NULL `skills.created_by` is reassigned
 * (never nulled), and the parent `DELETE FROM users` runs LAST.
 */
function fakeEnv(skillCount = 0) {
  const batched: string[] = []
  const prepare = (sql: string) => ({
    bind: (..._args: unknown[]) => ({
      _sql: sql,
      async first() {
        return { n: skillCount }
      },
      async run() {
        return { meta: { changes: 0 } }
      }
    })
  })
  const DB = {
    prepare,
    async batch(stmts: Array<{ _sql: string }>) {
      for (const s of stmts) batched.push(s._sql)
      return stmts.map(() => ({ meta: { changes: 1 } }))
    }
  }
  return { env: { DB } as unknown as Env, batched }
}

describe('deleteUser', () => {
  it('reports the number of skills reassigned', async () => {
    const { env } = fakeEnv(3)
    expect(await deleteUser(env, 'u1', 'admin1')).toEqual({ reassignedSkills: 3 })
  })

  it('deletes the user row LAST, after every authorship cleanup', async () => {
    const { env, batched } = fakeEnv()
    await deleteUser(env, 'u1', 'admin1')

    const deleteIdx = batched.findIndex((s) => /DELETE FROM users/.test(s))
    expect(deleteIdx).toBe(batched.length - 1)
    // everything before the delete is an UPDATE that clears/reassigns a ref
    expect(batched.slice(0, deleteIdx).every((s) => /^\s*UPDATE/.test(s))).toBe(true)
  })

  it('reassigns owned skills (NOT NULL) and de-attributes nullable authorship', async () => {
    const { env, batched } = fakeEnv()
    await deleteUser(env, 'u1', 'admin1')

    expect(batched.some((s) => /UPDATE skills SET created_by = \?1/.test(s))).toBe(true)
    for (const re of [
      /UPDATE documents\s+SET created_by = NULL/,
      /UPDATE doc_revisions\s+SET author_id\s+= NULL/,
      /UPDATE doc_editors\s+SET granted_by = NULL/,
      /UPDATE skill_revisions SET author_id\s+= NULL/,
      /UPDATE skill_attachments SET created_by = NULL/,
      /UPDATE doc_attachments SET created_by = NULL/
    ]) {
      expect(batched.some((s) => re.test(s))).toBe(true)
    }
  })
})
