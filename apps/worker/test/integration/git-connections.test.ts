import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import {
  createGitSource,
  getGitSharedCredential,
  getGitSourceById,
  gitAdminRowFor,
  isGitSourceVisibleToUser,
  replaceGitSourceVisibility,
  upsertGitSharedCredential
} from '../../src/db/queries/git-sources'
import { setGitConnectionAuthConfig } from '../../src/db/queries/git-connections'

/**
 * Phase-1 payoff of the connection/repo split (migration 0030): auth lives on
 * the CONNECTION, so a second repo attached to the same connection inherits its
 * shared credential + visibility — no reconfiguration.
 */

const testEnv = env as unknown as Env
const sealed = { ciphertext: new Uint8Array([1, 2, 3]), iv: new Uint8Array([4, 5, 6]), keyVersion: 1 }

async function seedUser(): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO users (id, email, name, idp, idp_sub, role, created_at)
     VALUES ('u-1', 'u1@example.com', NULL, 'github', 'gh-1', 'admin', 1)`
  ).run()
}

async function cleanup(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`DELETE FROM git_connections`),
    testEnv.DB.prepare(`DELETE FROM git_sources`),
    testEnv.DB.prepare(`DELETE FROM users`)
  ])
}

describe('git connection sharing (0030)', () => {
  beforeEach(seedUser)
  afterEach(cleanup)

  it('a repo created with createGitSource gets its own connection', async () => {
    const repo = await createGitSource(testEnv, {
      slug: 'repo-a',
      displayName: 'A',
      provider: 'github',
      owner: 'acme',
      repo: 'a',
      branch: 'main',
      createdBy: 'u-1'
    })
    expect(repo.connection_id).toBeTruthy()
  })

  it('a second repo on the same connection shares its shared credential', async () => {
    const a = await createGitSource(testEnv, {
      slug: 'repo-a',
      displayName: 'A',
      provider: 'github',
      owner: 'acme',
      repo: 'a',
      branch: 'main',
      createdBy: 'u-1'
    })
    // Attach B to A's connection (Phase-2 UI surfaces this; the query supports it now).
    const b = await createGitSource(testEnv, {
      slug: 'repo-b',
      displayName: 'B',
      provider: 'github',
      owner: 'acme',
      repo: 'b',
      branch: 'main',
      connectionId: a.connection_id,
      createdBy: 'u-1'
    })
    expect(b.connection_id).toBe(a.connection_id)

    // Set the shared token via repo A; reading via repo B must find it.
    await upsertGitSharedCredential(testEnv, a.id, { ...sealed, createdBy: 'u-1' })
    const viaB = await getGitSharedCredential(testEnv, b.id)
    expect(viaB).not.toBeNull()
    expect(Array.from(viaB!.ciphertext)).toEqual([1, 2, 3])
  })

  it('visibility granted via one repo applies to a sibling repo', async () => {
    const a = await createGitSource(testEnv, {
      slug: 'repo-a',
      displayName: 'A',
      provider: 'github',
      owner: 'acme',
      repo: 'a',
      branch: 'main',
      createdBy: 'u-1'
    })
    const b = await createGitSource(testEnv, {
      slug: 'repo-b',
      displayName: 'B',
      provider: 'github',
      owner: 'acme',
      repo: 'b',
      branch: 'main',
      connectionId: a.connection_id,
      createdBy: 'u-1'
    })
    await replaceGitSourceVisibility(testEnv, a.id, [{ scopeKind: 'everyone', scopeId: null }])
    expect(await isGitSourceVisibleToUser(testEnv, b.id, 'u-1')).toBe(true)
    // sanity: the row round-trips with its connection
    expect((await getGitSourceById(testEnv, b.id))?.connection_id).toBe(a.connection_id)
  })

  it('OAuth client config set on the connection surfaces on a sibling repo', async () => {
    const a = await createGitSource(testEnv, {
      slug: 'repo-a',
      displayName: 'A',
      provider: 'github',
      owner: 'acme',
      repo: 'a',
      branch: 'main',
      createdBy: 'u-1'
    })
    const b = await createGitSource(testEnv, {
      slug: 'repo-b',
      displayName: 'B',
      provider: 'github',
      owner: 'acme',
      repo: 'b',
      branch: 'main',
      connectionId: a.connection_id,
      createdBy: 'u-1'
    })
    await setGitConnectionAuthConfig(
      testEnv,
      a.connection_id,
      JSON.stringify({
        oauth: {
          clientId: 'cid',
          authorizeUrl: 'https://idp/authorize',
          tokenUrl: 'https://idp/token',
          scopes: ['repo']
        }
      })
    )
    const rowB = await gitAdminRowFor(testEnv, b.id, 'u-1')
    expect(rowB?.oauth?.clientId).toBe('cid')
  })
})
