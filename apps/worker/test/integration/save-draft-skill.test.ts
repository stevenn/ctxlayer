import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env as WorkerEnv } from '../../src/env'
import { saveDraftSkill, SaveDraftSkillError } from '../../src/skills/save-draft-skill'
import { getSkillById, listSkillRevisions, patchSkill } from '../../src/db/queries/skills'

/**
 * Upsert + versioning for save_draft_skill: iterating a skill must version
 * ONE artifact (a new skill_revision), never spawn duplicates. Runs against a
 * real D1 + R2 (bodies land in DOCS_BUCKET via the revision writer).
 */

const testEnv = env as unknown as WorkerEnv
const NOW = 1_780_000_000

async function seedUser(id: string) {
  await testEnv.DB.prepare(
    `INSERT INTO users (id, email, name, idp, idp_sub, role, created_at)
     VALUES (?1, ?2, NULL, 'github', ?3, 'user', ?4)`
  )
    .bind(id, `${id}@example.com`, `sub-${id}`, NOW)
    .run()
}

const save = (over: Partial<Parameters<typeof saveDraftSkill>[1]> & { userId: string }) =>
  saveDraftSkill(testEnv, {
    title: 'Deploy playbook',
    description: 'How we deploy',
    body: '# Deploy\n\nStep one.',
    ...over
  })

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM skill_revisions'),
    testEnv.DB.prepare('DELETE FROM skills'),
    testEnv.DB.prepare('DELETE FROM users')
  ])
})

describe('saveDraftSkill upsert', () => {
  it('creates a private draft on first save (version 1)', async () => {
    await seedUser('alice')
    const res = await save({ userId: 'alice', slug: 'sk-deploy' })
    expect(res.created).toBe(true)
    expect(res.status).toBe('draft')
    expect(res.version).toBe(1)
    const row = (await getSkillById(testEnv, res.id))!
    expect(row.visibility).toBe('private')
  })

  it('updates in place by skillId — same artifact, a new version', async () => {
    await seedUser('alice')
    const first = await save({ userId: 'alice', slug: 'sk-deploy' })
    const second = await save({
      userId: 'alice',
      skillId: first.id,
      body: '# Deploy\n\nStep one.\nStep two.'
    })
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id) // NOT a new skill
    expect(second.version).toBe(2)
    expect(await listSkillRevisions(testEnv, first.id)).toHaveLength(2)
  })

  it('upserts by matching slug when no skillId is given', async () => {
    await seedUser('alice')
    const first = await save({ userId: 'alice', slug: 'sk-deploy' })
    const second = await save({ userId: 'alice', slug: 'sk-deploy', body: '# Deploy\n\nRevised.' })
    expect(second.id).toBe(first.id)
    expect(second.created).toBe(false)
    expect(second.version).toBe(2)
  })

  it('reports a live update when the target is already published', async () => {
    await seedUser('alice')
    const first = await save({ userId: 'alice', slug: 'sk-deploy' })
    await patchSkill(testEnv, first.id, { status: 'published', visibility: 'org' })
    const res = await save({ userId: 'alice', skillId: first.id, body: '# Deploy\n\nLive edit.' })
    expect(res.created).toBe(false)
    expect(res.status).toBe('published') // stays published — edit is live
    expect(res.version).toBe(2)
  })

  it('refuses an explicit skillId owned by someone else, and never touches it', async () => {
    await seedUser('alice')
    await seedUser('bob')
    const bobs = await save({ userId: 'bob', slug: 'sk-bob' })
    await expect(save({ userId: 'alice', skillId: bobs.id })).rejects.toBeInstanceOf(
      SaveDraftSkillError
    )
    expect(await listSkillRevisions(testEnv, bobs.id)).toHaveLength(1) // untouched
  })

  it('does NOT upsert into another user\'s skill via slug — creates a fresh one', async () => {
    await seedUser('alice')
    await seedUser('bob')
    const bobs = await save({ userId: 'bob', slug: 'sk-shared' })
    const alices = await save({ userId: 'alice', slug: 'sk-shared' })
    expect(alices.id).not.toBe(bobs.id) // alice got her own new skill
    expect(alices.created).toBe(true)
    expect(await listSkillRevisions(testEnv, bobs.id)).toHaveLength(1) // bob's untouched
  })

  it('throws skill_not_found for an unknown skillId', async () => {
    await seedUser('alice')
    await expect(save({ userId: 'alice', skillId: 'nope' })).rejects.toMatchObject({
      code: 'skill_not_found'
    })
  })
})
