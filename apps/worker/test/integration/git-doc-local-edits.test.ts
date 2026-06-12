import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import { markGitDocLocallyEdited } from '../../src/db/queries/git-sources'

/**
 * Pins the clobber-guard fix: an editor save on a git-sourced doc must flip
 * it to `local_edits` so inbound cron sync (git/sync.ts) won't overwrite the
 * edit — but ONLY a clean git doc, never a pr_open one, and never an ordinary
 * non-git doc.
 */

const testEnv = env as unknown as Env
const NOW = 1_780_000_000

async function seed(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO git_sources (id, slug, display_name, provider, branch, created_at, updated_at)
       VALUES ('gs-1', 'gs-x', 'GS X', 'github', 'main', ?1, ?1)`
    ).bind(NOW),
    testEnv.DB.prepare(
      `INSERT INTO documents (id, title, slug, created_at, updated_at, git_source_id, git_path, git_sync_state)
       VALUES ('d-clean', 'Clean', 'd-clean', ?1, ?1, 'gs-1', 'docs/a.md', 'clean')`
    ).bind(NOW),
    testEnv.DB.prepare(
      `INSERT INTO documents (id, title, slug, created_at, updated_at, git_source_id, git_path, git_sync_state)
       VALUES ('d-pr', 'PR', 'd-pr', ?1, ?1, 'gs-1', 'docs/b.md', 'pr_open')`
    ).bind(NOW),
    testEnv.DB.prepare(
      `INSERT INTO documents (id, title, slug, created_at, updated_at)
       VALUES ('d-plain', 'Plain', 'd-plain', ?1, ?1)`
    ).bind(NOW)
  ])
}

async function syncState(id: string): Promise<string | null> {
  const r = await testEnv.DB.prepare(`SELECT git_sync_state FROM documents WHERE id = ?1`)
    .bind(id)
    .first<{ git_sync_state: string | null }>()
  return r?.git_sync_state ?? null
}

async function cleanup(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`DELETE FROM documents`),
    testEnv.DB.prepare(`DELETE FROM git_sources`)
  ])
}

describe('markGitDocLocallyEdited', () => {
  beforeEach(seed)
  afterEach(cleanup)

  it('flips a clean git doc to local_edits', async () => {
    await markGitDocLocallyEdited(testEnv, 'd-clean')
    expect(await syncState('d-clean')).toBe('local_edits')
  })

  it('does not downgrade a pr_open git doc', async () => {
    await markGitDocLocallyEdited(testEnv, 'd-pr')
    expect(await syncState('d-pr')).toBe('pr_open')
  })

  it('leaves an ordinary (non-git) doc untouched', async () => {
    await markGitDocLocallyEdited(testEnv, 'd-plain')
    expect(await syncState('d-plain')).toBeNull()
  })

  it('is idempotent once flagged', async () => {
    await markGitDocLocallyEdited(testEnv, 'd-clean')
    await markGitDocLocallyEdited(testEnv, 'd-clean')
    expect(await syncState('d-clean')).toBe('local_edits')
  })
})
