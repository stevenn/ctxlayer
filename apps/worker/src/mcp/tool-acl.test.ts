import { describe, it, expect } from 'vitest'
import {
  isToolAllowed,
  requiresFromRules,
  type ToolAccessRuleLike,
  type UserPrincipals
} from '@ctxlayer/shared'
import { indexToolAccess, accessKey, type ToolAccessRow } from '../db/queries/tool-access'
import { visibleTools } from './tools-proxy'
import type { UpstreamToolRow } from '../db/queries/upstream-tools'

// The per-tool ACL evaluation core. This is the security boundary that
// decides which proxied tools register (list-time hide) + what the
// `list_my_context` advisory reports — so the allow-list semantics get
// direct coverage here.

const principals = (over: Partial<UserPrincipals> = {}): UserPrincipals => ({
  roles: new Set(),
  teams: new Set(),
  products: new Set(),
  ...over
})

describe('isToolAllowed', () => {
  it('inherits (allows) when a tool has no rules', () => {
    expect(isToolAllowed(undefined, principals())).toBe(true)
    expect(isToolAllowed([], principals())).toBe(true)
  })

  it('locks to listed principals once any rule exists', () => {
    const rules: ToolAccessRuleLike[] = [{ principalKind: 'role', principalId: 'r_eng' }]
    // A user with no roles is now blocked even though they could see the upstream.
    expect(isToolAllowed(rules, principals())).toBe(false)
    expect(isToolAllowed(rules, principals({ roles: new Set(['r_eng']) }))).toBe(true)
  })

  it('grants on ANY matching rule across kinds (additive within the lock)', () => {
    const rules: ToolAccessRuleLike[] = [
      { principalKind: 'role', principalId: 'r_eng' },
      { principalKind: 'team', principalId: 't_yuki' }
    ]
    expect(isToolAllowed(rules, principals({ teams: new Set(['t_yuki']) }))).toBe(true)
    expect(isToolAllowed(rules, principals({ products: new Set(['p_driver']) }))).toBe(false)
  })

  it('treats an everyone rule as open to any signed-in caller', () => {
    const rules: ToolAccessRuleLike[] = [{ principalKind: 'everyone', principalId: '' }]
    expect(isToolAllowed(rules, principals())).toBe(true)
  })

  it('does not match a role the user lacks (no escalation)', () => {
    const rules: ToolAccessRuleLike[] = [{ principalKind: 'product', principalId: 'p_driver' }]
    expect(isToolAllowed(rules, principals({ roles: new Set(['p_driver']) }))).toBe(false)
  })
})

describe('requiresFromRules', () => {
  it('groups the unlocking principals by kind, dropping everyone', () => {
    const rules: ToolAccessRuleLike[] = [
      { principalKind: 'role', principalId: 'r_eng' },
      { principalKind: 'role', principalId: 'r_qa' },
      { principalKind: 'team', principalId: 't_yuki' },
      { principalKind: 'everyone', principalId: '' }
    ]
    expect(requiresFromRules(rules)).toEqual({
      roles: ['r_eng', 'r_qa'],
      teams: ['t_yuki'],
      products: []
    })
  })
})

describe('indexToolAccess', () => {
  it('keys rows by (upstream, tool) and groups rules', () => {
    const rows: ToolAccessRow[] = [
      { upstream_id: 'u1', tool_name: 'delete', principal_kind: 'role', principal_id: 'r_eng' },
      { upstream_id: 'u1', tool_name: 'delete', principal_kind: 'team', principal_id: 't_a' },
      { upstream_id: 'u1', tool_name: 'get', principal_kind: 'everyone', principal_id: '' }
    ]
    const idx = indexToolAccess(rows)
    expect(idx.get(accessKey('u1', 'delete'))).toHaveLength(2)
    expect(idx.get(accessKey('u1', 'get'))).toHaveLength(1)
    expect(idx.get(accessKey('u1', 'missing'))).toBeUndefined()
  })

  it('feeds isToolAllowed end-to-end', () => {
    const rows: ToolAccessRow[] = [
      { upstream_id: 'u1', tool_name: 'delete', principal_kind: 'role', principal_id: 'r_eng' }
    ]
    const idx = indexToolAccess(rows)
    const rules = idx.get(accessKey('u1', 'delete'))
    expect(isToolAllowed(rules, principals({ roles: new Set(['r_eng']) }))).toBe(true)
    expect(isToolAllowed(rules, principals({ roles: new Set(['r_qa']) }))).toBe(false)
  })
})

// `visibleTools` is the `describe_upstream` catalogue's ACL gate: it must drop
// exactly the tools `init()` would hide from registration, so the catalogue
// never leaks the name/summary of a tool the caller can't call.
describe('visibleTools', () => {
  const tool = (tool_name: string): UpstreamToolRow =>
    ({
      upstream_id: 'u1',
      tool_name,
      description: null,
      input_schema: '{}',
      cached_at: 0,
      input_schema_hash: null,
      last_schema_change_at: null,
      last_diff_summary: null
    }) as UpstreamToolRow

  // `get` is open (no rules); `delete` is locked to role r_eng.
  const acl = indexToolAccess([
    { upstream_id: 'u1', tool_name: 'delete', principal_kind: 'role', principal_id: 'r_eng' }
  ])

  it('drops a locked tool the caller does not match, keeps the open one', () => {
    const out = visibleTools('u1', [tool('get'), tool('delete')], acl, principals())
    expect(out.map((t) => t.tool_name)).toEqual(['get'])
  })

  it('keeps the locked tool once the caller has the principal', () => {
    const out = visibleTools(
      'u1',
      [tool('get'), tool('delete')],
      acl,
      principals({ roles: new Set(['r_eng']) })
    )
    expect(out.map((t) => t.tool_name)).toEqual(['get', 'delete'])
  })
})
