import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env as WorkerEnv } from '../../src/env'
import { prepareWriteBackRedirect } from '../../src/git/writeback'
import { writeSourceMarkdown } from '../../src/storage/docs-r2'

/**
 * Pins the B4 + B5 write-back guards (2026-08 review):
 *  - B4: a first write-back whose only diff is FRONTMATTER STYLE
 *    (emitFrontmatter re-emits managed keys, normalising quoting /
 *    flow-vs-block lists) is a no-op — no pure-churn PR.
 *  - B5: a doc whose oversize frontmatter was dropped at import
 *    (okf_frontmatter = null while source.md HAS a block) refuses
 *    write-back instead of silently stripping the block.
 * Both branches return before any git credential/provider work, so no
 * token or network is needed.
 */

const testEnv = env as unknown as WorkerEnv
const NOW = 1_780_000_000
const DOC = 'd-wb'

// Quirky-but-equivalent styling: single-quoted title, flow-style tags,
// a comment, non-canonical key order. Values match the DB rail state.
const QUIRKY_FM = `tags: [deploy, ops]  # curated by platform\ntitle: 'Deploy Guide'`
const BODY = '# Deploy Guide\n\nStep one.\n'
const SOURCE = `---\n${QUIRKY_FM}\n---\n\n${BODY}`

async function seedDoc(okfFrontmatter: string | null): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM doc_tags'),
    testEnv.DB.prepare('DELETE FROM git_pull_requests'),
    testEnv.DB.prepare('DELETE FROM documents'),
    testEnv.DB.prepare('DELETE FROM git_sources'),
    testEnv.DB.prepare(
      `INSERT INTO git_sources (id, slug, display_name, provider, branch, created_at, updated_at)
       VALUES ('gs-wb', 'gs-wb', 'GS WB', 'github', 'main', ?1, ?1)`
    ).bind(NOW),
    testEnv.DB.prepare(
      `INSERT INTO documents
         (id, title, slug, created_at, updated_at, git_source_id, git_path, git_sync_state, okf_frontmatter)
       VALUES (?1, 'Deploy Guide', 'd-wb', ?2, ?2, 'gs-wb', 'docs/deploy.md', 'local_edits', ?3)`
    ).bind(DOC, NOW, okfFrontmatter),
    testEnv.DB.prepare(
      `INSERT INTO doc_tags (doc_id, tag_kind, tag_value) VALUES (?1, 'tag', 'deploy')`
    ).bind(DOC),
    testEnv.DB.prepare(
      `INSERT INTO doc_tags (doc_id, tag_kind, tag_value) VALUES (?1, 'tag', 'ops')`
    ).bind(DOC)
  ])
}

beforeEach(async () => {
  await testEnv.DOCS_BUCKET.delete(`docs/${DOC}/source.md`)
})

describe('write-back frontmatter guards (real D1 + R2)', () => {
  it('B4: unchanged body + style-only frontmatter re-emit is a no-op', async () => {
    await seedDoc(QUIRKY_FM)
    await writeSourceMarkdown(testEnv, DOC, SOURCE)
    const out = await prepareWriteBackRedirect(testEnv, DOC, { actorId: 'u-1', markdown: BODY })
    // The no-op signature with no open PR: ok, nothing to redirect to.
    expect(out).toEqual({ ok: true, result: { redirectUrl: null, branch: null } })
  })

  it('B4: a genuine frontmatter value change is NOT a no-op', async () => {
    await seedDoc(QUIRKY_FM)
    await writeSourceMarkdown(testEnv, DOC, SOURCE)
    // Retitle in the rail: managed overlay now genuinely differs.
    await testEnv.DB.prepare(`UPDATE documents SET title = 'Renamed Guide' WHERE id = ?1`)
      .bind(DOC)
      .run()
    const out = await prepareWriteBackRedirect(testEnv, DOC, { actorId: 'u-1', markdown: BODY })
    // Gets past the no-op branches and dies on the (unseeded) write token —
    // proof the change would have proposed a PR.
    expect(out).toEqual({ ok: false, status: 400, error: 'no_write_token' })
  })

  it('B5: refuses write-back when the source has frontmatter but the stored copy was dropped', async () => {
    await seedDoc(null)
    await writeSourceMarkdown(testEnv, DOC, SOURCE)
    const out = await prepareWriteBackRedirect(testEnv, DOC, { actorId: 'u-1', markdown: BODY })
    expect(out).toEqual({ ok: false, status: 422, error: 'frontmatter_dropped' })
  })

  it('plain docs (no frontmatter anywhere) still no-op on identical bodies', async () => {
    await seedDoc(null)
    await writeSourceMarkdown(testEnv, DOC, BODY)
    const out = await prepareWriteBackRedirect(testEnv, DOC, { actorId: 'u-1', markdown: BODY })
    expect(out).toEqual({ ok: true, result: { redirectUrl: null, branch: null } })
  })
})
