import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import {
  createGitSource,
  gitAdminRowFor,
  patchGitSource,
  setGitSyncIdentity,
  type GitSourceRow
} from '../../src/db/queries/git-sources'
import { listDueGitSyncs } from '../../src/git/sync'

/**
 * Designated scheduled-sync identity (migration 0034): the hourly cron may
 * run a user_* read strategy with a self-designated user's stored git
 * credential. These pin the enqueue gate — the security-relevant piece:
 * no designation ⇒ no unattended act-as, and a designee who is suspended
 * or gone is skipped, never acted as.
 */

const testEnv = env as unknown as Env
const NOW = 2_000_000_000

async function seedUser(id: string, status: 'active' | 'suspended' = 'active'): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO users (id, email, name, idp, idp_sub, role, status, created_at)
     VALUES (?1, ?2, NULL, 'github', ?3, 'admin', ?4, 1)`
  )
    .bind(id, `${id}@example.com`, `sub-${id}`, status)
    .run()
}

async function seedSource(slug: string, readStrategy: 'shared_bearer' | 'user_oauth') {
  const row = await createGitSource(testEnv, {
    slug,
    displayName: slug,
    provider: 'github',
    owner: 'acme',
    repo: slug,
    branch: 'main',
    createdBy: 'u-1'
  })
  if (readStrategy !== row.read_strategy) {
    await patchGitSource(testEnv, row.id, { readStrategy })
  }
  return row
}

async function cleanup(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`DELETE FROM git_connections`),
    testEnv.DB.prepare(`DELETE FROM git_sources`),
    testEnv.DB.prepare(`DELETE FROM users`)
  ])
}

describe('listDueGitSyncs (designated sync identity)', () => {
  beforeEach(() => seedUser('u-1'))
  afterEach(cleanup)

  it('lists a due shared_bearer source with no acting user', async () => {
    const s = await seedSource('repo-shared', 'shared_bearer')
    const { due, total } = await listDueGitSyncs(testEnv, NOW)
    expect(total).toBe(1)
    expect(due).toEqual([{ sourceId: s.id, slug: 'repo-shared' }])
  })

  it('skips a user_oauth source with no designated identity', async () => {
    await seedSource('repo-user', 'user_oauth')
    const { due } = await listDueGitSyncs(testEnv, NOW)
    expect(due).toEqual([])
  })

  it('lists a user_oauth source once its owner self-designates', async () => {
    const s = await seedSource('repo-user', 'user_oauth')
    await setGitSyncIdentity(testEnv, s.id, 'u-1')
    const { due } = await listDueGitSyncs(testEnv, NOW)
    expect(due).toEqual([{ sourceId: s.id, slug: 'repo-user', userId: 'u-1' }])
  })

  it('never acts as a suspended or deleted designee', async () => {
    const s = await seedSource('repo-user', 'user_oauth')
    await seedUser('u-suspended', 'suspended')
    await setGitSyncIdentity(testEnv, s.id, 'u-suspended')
    expect((await listDueGitSyncs(testEnv, NOW)).due).toEqual([])

    await setGitSyncIdentity(testEnv, s.id, 'u-ghost')
    expect((await listDueGitSyncs(testEnv, NOW)).due).toEqual([])
  })

  it('respects due-ness for designated sources too', async () => {
    const s = await seedSource('repo-user', 'user_oauth')
    await setGitSyncIdentity(testEnv, s.id, 'u-1')
    // Synced just now → daily interval not elapsed.
    await testEnv.DB.prepare(`UPDATE git_sources SET last_synced_at = ?2 WHERE id = ?1`)
      .bind(s.id, NOW - 60)
      .run()
    expect((await listDueGitSyncs(testEnv, NOW)).due).toEqual([])
  })

  it('hydrates the designation (email) into the admin row, and clears', async () => {
    const s = await seedSource('repo-user', 'user_oauth')
    await setGitSyncIdentity(testEnv, s.id, 'u-1')
    let row = await gitAdminRowFor(testEnv, s.id, 'u-1')
    expect(row?.syncAsUser).toEqual({ userId: 'u-1', email: 'u-1@example.com' })

    await setGitSyncIdentity(testEnv, s.id, null)
    row = await gitAdminRowFor(testEnv, s.id, 'u-1')
    expect(row?.syncAsUser).toBeNull()
  })
})

// Keep the row-shape import honest — createGitSource must return the new column.
const _typecheck: keyof GitSourceRow = 'sync_as_user_id'
void _typecheck
