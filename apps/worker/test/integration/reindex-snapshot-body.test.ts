import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env as WorkerEnv } from '../../src/env'
import { resolveDocBody } from '../../src/queues/reindex-consumer'
import { writeMaterializedSnapshot, writeSourceMarkdown } from '../../src/storage/docs-r2'

/**
 * Pins the `source: 'snapshot'` reindex branch (B2 / DO-owns-current-
 * content): the DocRoomDO enqueues reindex messages for materialised
 * snapshots that have NO revision object — the consumer must read
 * snapshot.json, not doc_revisions.
 */

const testEnv = env as unknown as WorkerEnv
const DOC = 'd-snapbody'

const CONTENT = {
  blocks: [
    {
      id: 'b1',
      type: 'heading',
      props: { level: 1 },
      content: [{ type: 'text', text: 'Title', styles: {} }],
      children: []
    },
    {
      id: 'b2',
      type: 'paragraph',
      props: {},
      content: [{ type: 'text', text: 'Hello from the DO.', styles: {} }],
      children: []
    }
  ]
}

beforeEach(async () => {
  await testEnv.DOCS_BUCKET.delete([
    `docs/${DOC}/snapshot.json`,
    `docs/${DOC}/source.md`,
    `docs/${DOC}/revisions/rev-x.json`
  ])
})

describe('resolveDocBody (real R2)', () => {
  it('snapshot source reads the materialised snapshot (no revision object exists)', async () => {
    await writeMaterializedSnapshot(testEnv, DOC, CONTENT)
    const md = await resolveDocBody(testEnv, {
      docId: DOC,
      revisionId: 'do-materialise',
      source: 'snapshot'
    })
    expect(md).toContain('# Title')
    expect(md).toContain('Hello from the DO.')
  })

  it('snapshot source returns null when no snapshot exists', async () => {
    expect(
      await resolveDocBody(testEnv, { docId: DOC, revisionId: 'do-materialise', source: 'snapshot' })
    ).toBeNull()
  })

  it('the default (revision) source still returns null for a missing revision', async () => {
    await writeMaterializedSnapshot(testEnv, DOC, CONTENT)
    expect(await resolveDocBody(testEnv, { docId: DOC, revisionId: 'rev-x' })).toBeNull()
  })

  it('git source strips frontmatter from source.md', async () => {
    await writeSourceMarkdown(testEnv, DOC, '---\ntitle: T\n---\n\nBody text.\n')
    const md = await resolveDocBody(testEnv, { docId: DOC, revisionId: 'sha', source: 'git' })
    expect(md).not.toContain('title: T')
    expect(md).toContain('Body text.')
  })
})
