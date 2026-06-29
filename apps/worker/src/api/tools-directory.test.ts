import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_SLUGS, type UserPrincipals } from '@ctxlayer/shared'
import { groupDirectoryTools, resolveRequiresNames, type NameMaps } from './tools-directory'
import { indexToolAccess, type ToolAccessRow } from '../db/queries/tool-access'
import { mangleToolName } from '../mcp/tool-name'
import type { UpstreamToolRow } from '../db/queries/upstream-tools'

const principals = (over: Partial<UserPrincipals> = {}): UserPrincipals => ({
  roles: new Set(),
  teams: new Set(),
  products: new Set(),
  ...over
})

const tool = (tool_name: string, description: string | null = null): UpstreamToolRow =>
  ({
    upstream_id: 'u1',
    tool_name,
    description,
    input_schema: '{}',
    cached_at: 0,
    input_schema_hash: null,
    last_schema_change_at: null,
    last_diff_summary: null
  }) as UpstreamToolRow

const names: NameMaps = {
  roles: new Map([['r_eng', 'Engineering']]),
  teams: new Map([['t_yuki', 'Yuki']]),
  products: new Map([['p_driver', 'Driver']])
}

// wit_query is locked to role r_eng; everything else is open.
const acl = indexToolAccess([
  { upstream_id: 'u1', tool_name: 'wit_query', principal_kind: 'role', principal_id: 'r_eng' }
] as ToolAccessRow[])

describe('groupDirectoryTools', () => {
  it('groups by family with "" last, and pins the callable name', () => {
    const groups = groupDirectoryTools(
      'u1',
      'up-ado',
      [tool('wit_work_item'), tool('wit_query'), tool('repo_branch'), tool('search')],
      acl,
      principals({ roles: new Set(['r_eng']) }), // matches the lock so all show unrestricted
      names
    )
    expect(groups.map((g) => g.family)).toEqual(['repo', 'wit', ''])
    const wit = groups.find((g) => g.family === 'wit')
    expect(wit?.tools.map((t) => t.name)).toEqual(['wit_query', 'wit_work_item'])
    expect(wit?.tools[0]?.call).toBe(mangleToolName('up-ado', 'wit_query'))
  })

  it('SHOWS a locked tool with restricted:true + requires as display names', () => {
    const groups = groupDirectoryTools('u1', 'up-ado', [tool('wit_query')], acl, principals(), names)
    const t = groups[0]?.tools[0]
    expect(t?.name).toBe('wit_query') // shown, not hidden
    expect(t?.restricted).toBe(true)
    expect(t?.requires).toEqual({ roles: ['Engineering'], teams: [], products: [] })
  })

  it('a matched caller sees the locked tool as unrestricted, no requires', () => {
    const groups = groupDirectoryTools(
      'u1',
      'up-ado',
      [tool('wit_query')],
      acl,
      principals({ roles: new Set(['r_eng']) }),
      names
    )
    expect(groups[0]?.tools[0]).toMatchObject({ restricted: false })
    expect(groups[0]?.tools[0]?.requires).toBeUndefined()
  })

  it('an open (no-rule) tool is never restricted', () => {
    const groups = groupDirectoryTools('u1', 'up-ado', [tool('wit_work_item')], acl, principals(), names)
    expect(groups[0]?.tools[0]).toMatchObject({ restricted: false })
    expect(groups[0]?.tools[0]?.requires).toBeUndefined()
  })
})

describe('resolveRequiresNames', () => {
  it('maps ids to display names', () => {
    expect(
      resolveRequiresNames({ roles: ['r_eng'], teams: ['t_yuki'], products: ['p_driver'] }, names)
    ).toEqual({ roles: ['Engineering'], teams: ['Yuki'], products: ['Driver'] })
  })

  it('falls back to the raw id for an orphaned (deleted) principal', () => {
    expect(resolveRequiresNames({ roles: ['r_gone'], teams: [], products: [] }, names)).toEqual({
      roles: ['r_gone'],
      teams: [],
      products: []
    })
  })
})

// Drift guard: BUILTIN_TOOLS must stay in lockstep with the MCP registrations
// in session-do.ts + skill-mcp.ts. Adding/removing a built-in fails this until
// the catalogue is updated.
describe('BUILTIN_TOOL_SLUGS', () => {
  it('is the pinned set of built-in tool names', () => {
    expect(BUILTIN_TOOL_SLUGS).toEqual([
      'whoami',
      'list_my_context',
      'list_upstreams',
      'describe_upstream',
      'get_doc',
      'search_docs',
      'list_skills',
      'get_skill'
    ])
  })
})
