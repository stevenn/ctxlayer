import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { unpackArchive } from '../../src/bundle/archive'
import { composeBundle } from '../../src/bundle/export'
import type { Env as WorkerEnv } from '../../src/env'

/**
 * Bundle export end-to-end against a real (migrated) D1 + R2: a folder subtree
 * packs into an archive with each doc at its concept path relative to the
 * bundle root, plus a generated index.md. (Bodies read from R2 are empty here —
 * we assert the bundle STRUCTURE + frontmatter, not body content.)
 */

const testEnv = env as unknown as WorkerEnv
const NOW = 1_780_000_000
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

async function seedDoc(opts: {
  id: string
  folder: string | null
  slug: string
  title: string
  type?: string
  description?: string
}) {
  await testEnv.DB.prepare(
    `INSERT INTO documents (id, title, slug, folder, doc_type, description, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`
  )
    .bind(opts.id, opts.title, opts.slug, opts.folder, opts.type ?? null, opts.description ?? null, NOW)
    .run()
}

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM documents').run()
})

describe('composeBundle', () => {
  it('packs a folder subtree at concept paths + a root index.md', async () => {
    await seedDoc({ id: 'A', folder: '/specs', slug: 'guide', title: 'Guide', type: 'Playbook' })
    await seedDoc({
      id: 'B',
      folder: '/specs/api',
      slug: 'auth',
      title: 'Auth',
      description: 'How to auth'
    })

    const out = await composeBundle(testEnv, '/specs', 'tar.gz')
    expect(out.docCount).toBe(2)
    expect(out.filename).toBe('specs.tar.gz')

    const files = new Map(
      unpackArchive(out.bytes, 'tar.gz').map((f) => [f.path, dec(f.bytes)])
    )
    // Concept paths are relative to the bundle root (/specs).
    expect(files.has('guide.md')).toBe(true)
    expect(files.has('api/auth.md')).toBe(true)
    expect(files.get('guide.md')).toContain('type: Playbook')
    expect(files.get('guide.md')).toContain('title: Guide')
    // Generated root index.md with okf_version + a contents list.
    const index = files.get('index.md') ?? ''
    expect(index).toContain('okf_version: "0.1"')
    expect(index).toContain('[Guide](guide.md)')
    expect(index).toContain('[Auth](api/auth.md) - How to auth')
  })

  it('round-trips as zip too', async () => {
    await seedDoc({ id: 'A', folder: '/specs', slug: 'guide', title: 'Guide' })
    const out = await composeBundle(testEnv, '/specs', 'zip')
    expect(out.filename).toBe('specs.zip')
    const files = new Map(unpackArchive(out.bytes, 'zip').map((f) => [f.path, dec(f.bytes)]))
    expect(files.has('guide.md')).toBe(true)
    expect(files.has('index.md')).toBe(true)
  })
})
