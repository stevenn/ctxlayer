import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseFrontmatter } from '@ctxlayer/shared'
import { addDocTags, listTagsForDoc } from '../../src/db/queries/doc-tags'
import type { Env as WorkerEnv } from '../../src/env'

/**
 * Reproduces the OKF import path for tags against a real (migrated) D1:
 * parse frontmatter → addDocTags → listTagsForDoc. Confirms the tag rows
 * land under tag_kind='tag' (migration 0026) and read back verbatim.
 */

const testEnv = env as unknown as WorkerEnv
const NOW = 1_780_000_000

async function seedDoc(id: string) {
  await testEnv.DB.prepare(
    `INSERT INTO documents (id, title, slug, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)`
  )
    .bind(id, `Doc ${id}`, id, NOW)
    .run()
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM doc_tags'),
    testEnv.DB.prepare('DELETE FROM documents')
  ])
})

describe('OKF tag import', () => {
  it('addDocTags persists free-form tags verbatim and reads them back', async () => {
    await seedDoc('d1')
    await addDocTags(testEnv, 'd1', ['BigQuery Table', 'Q3 Planning'])
    const tags = await listTagsForDoc(testEnv, 'd1')
    expect(tags.tags).toEqual(['BigQuery Table', 'Q3 Planning'])
  })

  it('end-to-end: frontmatter tags block → addDocTags → visible', async () => {
    await seedDoc('d2')
    const md = '---\ntype: Playbook\ntags:\n  - billing\n  - onboarding\n---\n\n# Body'
    const { known } = parseFrontmatter(md)
    expect(known.tags).toEqual(['billing', 'onboarding'])
    await addDocTags(testEnv, 'd2', known.tags ?? [])
    const tags = await listTagsForDoc(testEnv, 'd2')
    expect(tags.tags).toEqual(['billing', 'onboarding'])
  })

  it('inline tag list also imports', async () => {
    await seedDoc('d3')
    const { known } = parseFrontmatter('---\ntags: [alpha, beta]\n---\nbody')
    await addDocTags(testEnv, 'd3', known.tags ?? [])
    const tags = await listTagsForDoc(testEnv, 'd3')
    expect(tags.tags).toEqual(['alpha', 'beta'])
  })

  it('scalar tag (a single quoted string, not a list) imports', async () => {
    await seedDoc('d4')
    // The exact shape of the ali-baba sample: `tags: "storytime"`.
    const { known } = parseFrontmatter('---\ntype: Document\ntags: "storytime"\n---\nbody')
    expect(known.tags).toEqual(['storytime'])
    await addDocTags(testEnv, 'd4', known.tags ?? [])
    const tags = await listTagsForDoc(testEnv, 'd4')
    expect(tags.tags).toEqual(['storytime'])
  })
})
