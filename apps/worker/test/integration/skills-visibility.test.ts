import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env as WorkerEnv } from '../../src/env'
import {
  createSkill,
  getSkillById,
  listPublishedSkills,
  listSkillsVisibleToUser
} from '../../src/db/queries/skills'
import { canReadSkill } from '../../src/skills/skill-access'
import { buildSkillExport } from '../../src/skills/export'

/**
 * Skill visibility against a real D1 — the two-axis model (status ×
 * visibility) + ownership. This is the security-load-bearing surface: a
 * private draft must never surface to a non-owner. Pins the list queries,
 * the published-library gate, the export set, and the combined REST read
 * gate (getSkillById + canReadSkill).
 */

const testEnv = env as unknown as WorkerEnv
const NOW = 1_780_000_000

async function seedUser(id: string, role: 'user' | 'admin' = 'user') {
  await testEnv.DB.prepare(
    `INSERT INTO users (id, email, name, idp, idp_sub, role, created_at)
     VALUES (?1, ?2, NULL, 'github', ?3, ?4, ?5)`
  )
    .bind(id, `${id}@example.com`, `sub-${id}`, role, NOW)
    .run()
}

function seedSkill(opts: {
  slug: string
  ownerId: string
  visibility: 'private' | 'org'
  status: 'draft' | 'published' | 'archived'
}) {
  return createSkill(testEnv, {
    slug: opts.slug,
    title: `Skill ${opts.slug}`,
    description: `desc ${opts.slug}`,
    createdBy: opts.ownerId,
    visibility: opts.visibility,
    status: opts.status
  })
}

const slugs = (rows: { slug: string }[]) => new Set(rows.map((r) => r.slug))

// One shared fixture spanning every (owner × visibility × status) cell we care
// about. Returns the created rows keyed by slug for id lookups.
async function seedFixture() {
  await Promise.all([seedUser('alice'), seedUser('bob'), seedUser('admin1', 'admin')])
  const rows = {
    A1: await seedSkill({ slug: 'a-priv-draft', ownerId: 'alice', visibility: 'private', status: 'draft' }),
    A2: await seedSkill({ slug: 'a-org-pub', ownerId: 'alice', visibility: 'org', status: 'published' }),
    AP: await seedSkill({ slug: 'a-priv-pub', ownerId: 'alice', visibility: 'private', status: 'published' }),
    B1: await seedSkill({ slug: 'b-priv-draft', ownerId: 'bob', visibility: 'private', status: 'draft' }),
    B2: await seedSkill({ slug: 'b-org-pub', ownerId: 'bob', visibility: 'org', status: 'published' }),
    B3: await seedSkill({ slug: 'b-org-draft', ownerId: 'bob', visibility: 'org', status: 'draft' })
  }
  return rows
}

beforeEach(async () => {
  // Skills first — skills.created_by is a NOT-NULL FK to users.
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM skills'),
    testEnv.DB.prepare('DELETE FROM users')
  ])
})

describe('listSkillsVisibleToUser', () => {
  it("shows a user their OWN skills (any status/visibility) + the org-published library", async () => {
    await seedFixture()
    const visible = await listSkillsVisibleToUser(testEnv, 'alice')
    // own: A1, A2, AP  +  others' org-published: B2.  NOT bob's private/draft.
    expect(slugs(visible)).toEqual(
      new Set(['a-priv-draft', 'a-org-pub', 'a-priv-pub', 'b-org-pub'])
    )
  })

  it('never leaks another user\'s private draft', async () => {
    await seedFixture()
    const visible = await listSkillsVisibleToUser(testEnv, 'bob')
    // own: B1, B2, B3  +  alice's org-published: A2.  NOT alice's private (A1/AP).
    expect(slugs(visible)).toEqual(new Set(['b-priv-draft', 'b-org-pub', 'b-org-draft', 'a-org-pub']))
    expect(slugs(visible).has('a-priv-draft')).toBe(false)
    expect(slugs(visible).has('a-priv-pub')).toBe(false)
  })
})

describe('listPublishedSkills (the org library / MCP list_skills)', () => {
  it('is exactly the org-shared + published set — private-published is excluded', async () => {
    await seedFixture()
    const published = await listPublishedSkills(testEnv)
    expect(slugs(published)).toEqual(new Set(['a-org-pub', 'b-org-pub']))
    // a-priv-pub is published but private → must NOT be in the library.
    expect(slugs(published).has('a-priv-pub')).toBe(false)
    // b-org-draft is org but still a draft → excluded.
    expect(slugs(published).has('b-org-draft')).toBe(false)
  })
})

describe('buildSkillExport (web .zip / pull replacement)', () => {
  it('exports only the published org library', async () => {
    await seedFixture()
    const { skills } = await buildSkillExport(testEnv)
    expect(new Set(skills.map((s) => s.slug))).toEqual(new Set(['a-org-pub', 'b-org-pub']))
  })
})

describe('REST read gate (getSkillById + canReadSkill)', () => {
  it('hides a stranger private draft (404), allows owner + admin + org-published', async () => {
    const rows = await seedFixture()
    const a1 = (await getSkillById(testEnv, rows.A1.id))!
    const a2 = (await getSkillById(testEnv, rows.A2.id))!
    const ap = (await getSkillById(testEnv, rows.AP.id))!

    expect(canReadSkill(a1, 'bob', 'user')).toBe(false) // stranger private draft
    expect(canReadSkill(a1, 'alice', 'user')).toBe(true) // owner
    expect(canReadSkill(a1, 'admin1', 'admin')).toBe(true) // admin
    expect(canReadSkill(a2, 'bob', 'user')).toBe(true) // org-published
    expect(canReadSkill(ap, 'bob', 'user')).toBe(false) // private, even though published
  })
})
