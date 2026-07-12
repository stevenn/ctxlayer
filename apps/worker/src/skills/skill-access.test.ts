import { describe, expect, it } from 'vitest'
import { canReadSkill, canWriteSkill } from './skill-access'

// The read gate collapses two axes + ownership:
//   readable = admin OR owner OR (visibility==='org' AND status==='published')
// Write is owner-or-admin. These pure predicates are the single source of
// truth for the skill ACL, so pin the whole matrix.

const row = (over: Partial<{ created_by: string; visibility: 'private' | 'org'; status: 'draft' | 'published' | 'archived' }> = {}) => ({
  created_by: 'alice',
  visibility: 'private' as const,
  status: 'draft' as const,
  ...over
})

describe('canReadSkill', () => {
  it('admin reads anything, including a stranger private draft', () => {
    expect(canReadSkill(row(), 'admin1', 'admin')).toBe(true)
  })

  it('owner reads their own private draft', () => {
    expect(canReadSkill(row({ created_by: 'alice' }), 'alice', 'user')).toBe(true)
  })

  it('a non-owner CANNOT read a private draft (no existence leak)', () => {
    expect(canReadSkill(row({ created_by: 'alice' }), 'bob', 'user')).toBe(false)
  })

  it('a non-owner reads an org-shared, published skill', () => {
    expect(canReadSkill(row({ visibility: 'org', status: 'published' }), 'bob', 'user')).toBe(true)
  })

  it('org + draft is NOT readable by a non-owner (not yet published)', () => {
    expect(canReadSkill(row({ visibility: 'org', status: 'draft' }), 'bob', 'user')).toBe(false)
  })

  it('private + published is NOT readable by a non-owner (not org-shared)', () => {
    expect(canReadSkill(row({ visibility: 'private', status: 'published' }), 'bob', 'user')).toBe(
      false
    )
  })

  it('anonymous (null user) reads only org-published', () => {
    expect(canReadSkill(row({ visibility: 'org', status: 'published' }), null, 'user')).toBe(true)
    expect(canReadSkill(row({ visibility: 'private' }), null, 'user')).toBe(false)
  })
})

describe('canWriteSkill', () => {
  it('owner and admin can write; a stranger cannot', () => {
    expect(canWriteSkill(row({ created_by: 'alice' }), 'alice', 'user')).toBe(true)
    expect(canWriteSkill(row({ created_by: 'alice' }), 'admin1', 'admin')).toBe(true)
    expect(canWriteSkill(row({ created_by: 'alice' }), 'bob', 'user')).toBe(false)
  })

  it('write does not depend on visibility/status — only ownership', () => {
    expect(canWriteSkill(row({ created_by: 'alice', visibility: 'org', status: 'published' }), 'bob', 'user')).toBe(false)
  })

  it('null user cannot write', () => {
    expect(canWriteSkill(row(), null, 'user')).toBe(false)
  })
})
