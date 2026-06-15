import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { rebuildDocLinks } from '../../src/docs/doc-links'
import {
  getIncomingLinkDocs,
  getIncomingLinks,
  getOutgoingLinkTargets,
  getOutgoingLinks
} from '../../src/db/queries/doc-links'
import type { Env as WorkerEnv } from '../../src/env'

/**
 * The doc-link graph rebuilt from markdown against a real (migrated) D1:
 * OKF concept paths resolve by slug, external links + dangling paths are
 * handled, and incoming/outgoing lookups work.
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
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM doc_links'),
    testEnv.DB.prepare('DELETE FROM documents')
  ])
})

describe('rebuildDocLinks', () => {
  it('resolves OKF paths by slug, keeps dangling, ignores external', async () => {
    await seedDoc('A', '/specs', 'doc-a')
    await seedDoc('B', '/specs/api', 'doc-b')
    const md = [
      'Link to [B](/specs/api/doc-b.md).',
      'A relative [B again](../api/doc-b.md).',
      'A [missing one](/specs/gone.md).',
      'An [external](https://example.com).',
      'An [image](/p.png) is not a link target either.'
    ].join('\n')

    await rebuildDocLinks(testEnv, 'A', md)

    const out = await getOutgoingLinks(testEnv, 'A')
    // Two distinct refs to B (absolute + relative) + one dangling. External /
    // non-.md ignored.
    expect(out.length).toBe(3)
    const resolved = out.filter((l) => l.target_doc_id === 'B').map((l) => l.target_ref).sort()
    expect(resolved).toEqual(['../api/doc-b.md', '/specs/api/doc-b.md'])
    const dangling = out.filter((l) => l.target_doc_id === null)
    expect(dangling.map((l) => l.target_ref)).toEqual(['/specs/gone.md'])

    const incoming = await getIncomingLinks(testEnv, 'B')
    // Two refs from A both resolve to B → two incoming rows, one source.
    expect(incoming.length).toBe(2)
    expect([...new Set(incoming.map((l) => l.source_doc_id))]).toEqual(['A'])
  })

  it('resolves a legacy /app/docs/{id} link and drops self-links', async () => {
    await seedDoc('A', null, 'doc-a')
    await seedDoc('B', null, 'doc-b')
    await rebuildDocLinks(testEnv, 'A', 'legacy [B](/app/docs/B) and self [me](/doc-a.md)')
    const out = await getOutgoingLinks(testEnv, 'A')
    // Self-link (slug doc-a → A) dropped; only the legacy link to B remains.
    expect(out.length).toBe(1)
    expect(out[0]?.target_doc_id).toBe('B')
  })

  it('replaces the prior link set on rebuild', async () => {
    await seedDoc('A', null, 'doc-a')
    await seedDoc('B', null, 'doc-b')
    await rebuildDocLinks(testEnv, 'A', '[B](/doc-b.md)')
    expect((await getOutgoingLinks(testEnv, 'A')).length).toBe(1)
    await rebuildDocLinks(testEnv, 'A', 'no links anymore')
    expect((await getOutgoingLinks(testEnv, 'A')).length).toBe(0)
  })
})

// Rail panel queries: incoming backlinks (distinct source docs) + outgoing
// links with their resolved target (or null = dangling).
describe('rail link queries', () => {
  it('getIncomingLinkDocs returns distinct source docs with title + slug', async () => {
    await seedDoc('A', '/specs', 'doc-a')
    await seedDoc('B', '/specs/api', 'doc-b')
    await seedDoc('C', null, 'doc-c')
    // A links to B twice (absolute + relative); C links to B once.
    await rebuildDocLinks(testEnv, 'A', '[B](/specs/api/doc-b.md) and [B](../api/doc-b.md)')
    await rebuildDocLinks(testEnv, 'C', 'see [B](/specs/api/doc-b.md)')

    const incoming = await getIncomingLinkDocs(testEnv, 'B')
    // Distinct sources (A once despite two refs), ordered by title.
    expect(incoming).toEqual([
      { id: 'A', title: 'Doc A', slug: 'doc-a' },
      { id: 'C', title: 'Doc C', slug: 'doc-c' }
    ])
  })

  it('getIncomingLinkDocs excludes a soft-deleted source', async () => {
    await seedDoc('A', null, 'doc-a')
    await seedDoc('B', null, 'doc-b')
    await rebuildDocLinks(testEnv, 'A', '[B](/doc-b.md)')
    await testEnv.DB.prepare('UPDATE documents SET deleted_at = ?2 WHERE id = ?1')
      .bind('A', NOW)
      .run()
    expect(await getIncomingLinkDocs(testEnv, 'B')).toEqual([])
  })

  it('getOutgoingLinkTargets resolves targets and reports dangling as null', async () => {
    await seedDoc('A', '/specs', 'doc-a')
    await seedDoc('B', '/specs/api', 'doc-b')
    await rebuildDocLinks(testEnv, 'A', '[B](/specs/api/doc-b.md) then [gone](/specs/gone.md)')

    const out = await getOutgoingLinkTargets(testEnv, 'A')
    expect(out.length).toBe(2)
    const resolved = out.find((o) => o.ref === '/specs/api/doc-b.md')
    expect(resolved?.target).toEqual({ id: 'B', title: 'Doc B', slug: 'doc-b' })
    const dangling = out.find((o) => o.ref === '/specs/gone.md')
    expect(dangling?.target).toBeNull()
  })
})
