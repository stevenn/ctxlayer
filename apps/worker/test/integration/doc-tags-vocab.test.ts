import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { listAllTagValues } from '../../src/db/queries/doc-tags'
import type { Env as WorkerEnv } from '../../src/env'

/**
 * The org-wide free-form tag vocabulary (powers the editor's tag
 * autocomplete): distinct `tag` values across non-deleted docs, most-used
 * first, excluding team/product tag kinds and soft-deleted docs.
 */

const testEnv = env as unknown as WorkerEnv
const NOW = 1_780_000_000

async function seedDoc(id: string, deleted = false) {
  await testEnv.DB.prepare(
    `INSERT INTO documents (id, title, slug, created_at, updated_at, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?4, ?5)`
  )
    .bind(id, `Doc ${id}`, `doc-${id.toLowerCase()}`, NOW, deleted ? NOW : null)
    .run()
}

async function tag(docId: string, kind: 'team' | 'product' | 'tag', value: string) {
  await testEnv.DB.prepare(
    `INSERT INTO doc_tags (doc_id, tag_kind, tag_value) VALUES (?1, ?2, ?3)`
  )
    .bind(docId, kind, value)
    .run()
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM doc_tags'),
    testEnv.DB.prepare('DELETE FROM documents')
  ])
})

describe('listAllTagValues', () => {
  it('returns distinct tags most-used-first, excluding deleted docs + non-tag kinds', async () => {
    await seedDoc('A')
    await seedDoc('B')
    await seedDoc('C', true) // soft-deleted

    await tag('A', 'tag', 'Peppol')
    await tag('A', 'tag', 'Billing')
    await tag('B', 'tag', 'Peppol') // Peppol now used twice
    await tag('A', 'team', 'team-eng') // team kind — must not appear
    await tag('C', 'tag', 'Archived') // on a deleted doc — must not appear

    const vocab = await listAllTagValues(testEnv)
    expect(vocab).toEqual(['Peppol', 'Billing'])
  })

  it('returns an empty list when nothing is tagged', async () => {
    await seedDoc('A')
    expect(await listAllTagValues(testEnv)).toEqual([])
  })
})
