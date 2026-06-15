import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { rewriteDocLinkHrefs } from '../../src/docs/link-rewrite'
import type { Env as WorkerEnv } from '../../src/env'

/**
 * Export-time link rewrite: doc links resolve to the target's CURRENT concept
 * path (move-consistency), dangling + external links pass through, and a
 * bundle root re-roots the path.
 */

const testEnv = env as unknown as WorkerEnv
const NOW = 1_780_000_000

async function seedDoc(id: string, folder: string | null, slug: string) {
  await testEnv.DB.prepare(
    `INSERT INTO documents (id, title, slug, folder, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)`
  )
    .bind(id, `Doc ${id}`, slug, folder, NOW)
    .run()
}

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM documents').run()
})

describe('rewriteDocLinkHrefs', () => {
  it("rewrites a link to the target's current path, keeps dangling + external", async () => {
    // B currently lives at /new/loc, but the link was authored at an old path.
    await seedDoc('B', '/new/loc', 'doc-b')
    const md = [
      'Stale link [B](/old/path/doc-b.md).',
      'Dangling [x](/gone.md).',
      'External [e](https://example.com).'
    ].join('\n')

    const out = await rewriteDocLinkHrefs(testEnv, md)
    expect(out).toContain('[B](/new/loc/doc-b.md)') // re-pointed to current path
    expect(out).toContain('[x](/gone.md)') // dangling unchanged
    expect(out).toContain('[e](https://example.com)') // external unchanged
  })

  it('re-roots the concept path relative to a bundle root', async () => {
    await seedDoc('B', '/specs/api', 'doc-b')
    const out = await rewriteDocLinkHrefs(testEnv, '[B](/specs/api/doc-b.md)', {
      bundleRoot: '/specs'
    })
    expect(out).toBe('[B](/api/doc-b.md)')
  })

  it('resolves a legacy /app/docs/{id} link to the concept path', async () => {
    await seedDoc('B', null, 'doc-b')
    const out = await rewriteDocLinkHrefs(testEnv, '[B](/app/docs/B)')
    expect(out).toBe('[B](/doc-b.md)')
  })
})
