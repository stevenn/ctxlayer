import { describe, expect, it, vi, beforeEach } from 'vitest'

// buildDraftContext fans out across D1 (upstreams, tools, skills), R2
// (snapshots), and the RAG/usage enrichers; mock all of those so the test
// drives the multi-upstream assembly logic. `mangleToolName` / transport
// guard (shared, pure) stay REAL.
vi.mock('../db/queries/upstreams', () => ({ getUpstreamBySlug: vi.fn() }))
vi.mock('../db/queries/upstream-tools', () => ({ listCachedTools: vi.fn() }))
vi.mock('../db/queries/skills', () => ({ listPublishedSkills: vi.fn() }))
vi.mock('../storage/skills-r2', () => ({ readSnapshot: vi.fn() }))
vi.mock('./draft-context-bundle', () => ({
  findRelatedDocs: vi.fn(),
  buildUsageAggregates: vi.fn()
}))
vi.mock('../rag/markdown', () => ({ renderBlocksToMarkdown: vi.fn(() => '') }))

import { buildDraftContext } from './draft-context'
import { getUpstreamBySlug, type UpstreamServerRow } from '../db/queries/upstreams'
import { listCachedTools, type UpstreamToolRow } from '../db/queries/upstream-tools'
import { listPublishedSkills } from '../db/queries/skills'
import { findRelatedDocs, buildUsageAggregates } from './draft-context-bundle'
import type { Env } from '../env'

const mockedGetUpstream = vi.mocked(getUpstreamBySlug)
const mockedTools = vi.mocked(listCachedTools)
const mockedSkills = vi.mocked(listPublishedSkills)
const mockedRelated = vi.mocked(findRelatedDocs)
const mockedUsage = vi.mocked(buildUsageAggregates)

const env = {} as Env

function upstreamRow(slug: string): UpstreamServerRow {
  return {
    id: `${slug}-id`,
    slug,
    display_name: slug.toUpperCase(),
    transport: 'streamable_http'
  } as unknown as UpstreamServerRow
}

function tool(upstreamId: string, name: string): UpstreamToolRow {
  return {
    upstream_id: upstreamId,
    tool_name: name,
    description: null,
    input_schema: '{}',
    cached_at: 0,
    input_schema_hash: null,
    last_schema_change_at: null,
    last_diff_summary: null
  }
}

const CATALOGUE: Record<string, UpstreamToolRow[]> = {
  'up-ado-id': [tool('up-ado-id', 'wit_work_item'), tool('up-ado-id', 'repo_file')],
  'up-driver-id': [tool('up-driver-id', 'get_source_file')]
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedGetUpstream.mockImplementation(async (_env: Env, slug: string) =>
    slug === 'up-ado' || slug === 'up-driver' ? upstreamRow(slug) : null
  )
  mockedTools.mockImplementation(
    async (_env: Env, upstreamId: string) => CATALOGUE[upstreamId] ?? []
  )
  mockedSkills.mockResolvedValue([])
  mockedRelated.mockResolvedValue([])
  mockedUsage.mockResolvedValue(null)
})

describe('buildDraftContext (multi-upstream)', () => {
  it('assembles one section per upstream, in order', async () => {
    const res = await buildDraftContext(env, {
      upstreamSlugs: ['up-ado', 'up-driver'],
      toolName: undefined,
      operatorPrompt: null,
      userId: 'u'
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.bundle.upstreams.map((u) => u.slug)).toEqual(['up-ado', 'up-driver'])
    const ado = res.bundle.upstreams[0]
    expect(ado?.allTools.map((t) => t.name)).toEqual(['wit_work_item', 'repo_file'])
    expect(ado?.allTools.map((t) => t.mangledName)).toEqual([
      'up-ado__wit_work_item',
      'up-ado__repo_file'
    ])
    expect(ado?.focusTool).toBeNull()
  })

  it('dedups the upstream list', async () => {
    const res = await buildDraftContext(env, {
      upstreamSlugs: ['up-ado', 'up-ado'],
      toolName: undefined,
      operatorPrompt: null,
      userId: 'u'
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.bundle.upstreams).toHaveLength(1)
  })

  it('resolves a focus tool on whichever upstream owns it', async () => {
    const res = await buildDraftContext(env, {
      upstreamSlugs: ['up-ado', 'up-driver'],
      toolName: 'get_source_file',
      operatorPrompt: null,
      userId: 'u'
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const [ado, driver] = res.bundle.upstreams
    expect(ado?.focusTool).toBeNull()
    expect(driver?.focusTool?.name).toBe('get_source_file')
  })

  it('errors tool_not_found when the focus tool matches no upstream', async () => {
    const res = await buildDraftContext(env, {
      upstreamSlugs: ['up-ado', 'up-driver'],
      toolName: 'nope',
      operatorPrompt: null,
      userId: 'u'
    })
    expect(res).toEqual({ ok: false, error: 'tool_not_found', status: 404 })
  })

  it('errors upstream_not_found for an unknown slug', async () => {
    const res = await buildDraftContext(env, {
      upstreamSlugs: ['up-ado', 'ghost'],
      toolName: undefined,
      operatorPrompt: null,
      userId: 'u'
    })
    expect(res).toEqual({ ok: false, error: 'upstream_not_found', status: 404 })
  })

  it('unions relatedDocs across upstreams and dedups by slug', async () => {
    mockedRelated.mockImplementation(
      async (_env: Env, { upstreamSlug }: { upstreamSlug: string }) =>
        upstreamSlug === 'up-ado'
          ? [
              { slug: 'doc-a', title: 'A', excerpt: '' },
              { slug: 'shared', title: 'S', excerpt: '' }
            ]
          : [
              { slug: 'shared', title: 'S', excerpt: '' },
              { slug: 'doc-b', title: 'B', excerpt: '' }
            ]
    )
    const res = await buildDraftContext(env, {
      upstreamSlugs: ['up-ado', 'up-driver'],
      toolName: undefined,
      operatorPrompt: null,
      userId: 'u'
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.bundle.relatedDocs.map((d) => d.slug)).toEqual(['doc-a', 'shared', 'doc-b'])
  })
})
