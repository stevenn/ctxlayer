import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { packArchive } from '../../src/bundle/archive'
import { importBundle } from '../../src/bundle/import'
import { readSourceMarkdown } from '../../src/storage/docs-r2'
import type { Env as WorkerEnv } from '../../src/env'

/**
 * Bundle import end-to-end (D1 + R2): an archive grafts under a target folder,
 * each concept file becomes a doc, reserved files are skipped, and in-bundle
 * links resolve to the new docs' concept paths (two-pass).
 */

const testEnv = env as unknown as WorkerEnv
const enc = (s: string) => new TextEncoder().encode(s)

async function getDoc(slug: string) {
  return testEnv.DB.prepare(
    'SELECT id, slug, folder, doc_type FROM documents WHERE slug = ?1 AND deleted_at IS NULL'
  )
    .bind(slug)
    .first<{ id: string; slug: string; folder: string | null; doc_type: string | null }>()
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM doc_tags'),
    testEnv.DB.prepare('DELETE FROM documents'),
    testEnv.DB.prepare('DELETE FROM users')
  ])
  // created_by FKs to users — seed the importer.
  await testEnv.DB.prepare(
    `INSERT INTO users (id, email, name, idp, idp_sub, role, created_at)
     VALUES ('u1', 'u1@example.com', NULL, 'github', 'sub-u1', 'user', 1780000000)`
  ).run()
})

describe('importBundle', () => {
  it('grafts an archive under a target folder, two-pass link rewrite', async () => {
    const archive = packArchive(
      [
        {
          path: 'guide.md',
          bytes: enc('---\ntype: Playbook\ntitle: Guide\n---\n\nSee [Auth](/api/auth.md).')
        },
        { path: 'api/auth.md', bytes: enc('---\ntitle: Auth\n---\n\n# Auth') },
        { path: 'index.md', bytes: enc('---\nokf_version: "0.1"\n---\n# Contents') }
      ],
      'tar.gz'
    )

    const res = await importBundle(testEnv, {
      bytes: archive,
      format: 'tar.gz',
      targetFolder: '/imported',
      createdBy: 'u1'
    })
    expect(res.created).toBe(2) // index.md skipped
    expect(res.skipped).toBe(1)
    expect(res.okfVersion).toBe('0.1')
    expect(res.errors).toEqual([])

    const guide = await getDoc('guide')
    const auth = await getDoc('auth')
    expect(guide?.folder).toBe('/imported')
    expect(guide?.doc_type).toBe('Playbook')
    expect(auth?.folder).toBe('/imported/api')

    // The in-bundle link was re-pointed at the new doc's concept path.
    const guideSrc = await readSourceMarkdown(testEnv, guide?.id ?? '')
    expect(guideSrc).toContain('[Auth](/imported/api/auth.md)')
  })

  it('rejects a non-bundle / empty archive cleanly', async () => {
    const res = await importBundle(testEnv, {
      bytes: packArchive([{ path: 'readme.txt', bytes: enc('hi') }], 'zip'),
      format: 'zip',
      targetFolder: null,
      createdBy: 'u1'
    })
    expect(res.created).toBe(0)
    expect(res.errors[0]).toContain('no concept files')
  })
})
