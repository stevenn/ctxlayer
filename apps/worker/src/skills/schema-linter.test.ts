import { describe, expect, it, vi, beforeEach } from 'vitest'

// The linter pulls the skill's attachments + each attached upstream's cached
// catalogue from D1; mock both so the test drives the reference-matching
// logic directly. `renderBlocksToMarkdown` is mocked too (these tests pass
// pre-rendered strings, so it is never invoked) to keep the module load
// node-only. `collapseSlugPrefix` (shared, pure) is left REAL — it's the
// mangled↔native mapping under test.
vi.mock('../db/queries/skill-attachments', () => ({ listAttachmentsForSkill: vi.fn() }))
vi.mock('../db/queries/upstream-tools', () => ({ listCachedTools: vi.fn() }))
vi.mock('../rag/markdown', () => ({ renderBlocksToMarkdown: vi.fn(() => '') }))

import { lintSkillBody } from './schema-linter'
import { listAttachmentsForSkill, type SkillAttachmentRow } from '../db/queries/skill-attachments'
import { listCachedTools, type UpstreamToolRow } from '../db/queries/upstream-tools'
import type { Env } from '../env'

const mockedAttachments = vi.mocked(listAttachmentsForSkill)
const mockedTools = vi.mocked(listCachedTools)

function attach(upstream_slug: string, upstream_id: string): SkillAttachmentRow {
  return { skill_id: 'sk', upstream_id, upstream_slug, tool_name: '' }
}

function tool(upstream_id: string, tool_name: string): UpstreamToolRow {
  return {
    upstream_id,
    tool_name,
    description: null,
    input_schema: '{}',
    cached_at: 0,
    input_schema_hash: null,
    last_schema_change_at: null,
    last_diff_summary: null
  }
}

function setup(
  attachments: SkillAttachmentRow[],
  toolsByUpstream: Record<string, UpstreamToolRow[]>
): void {
  mockedAttachments.mockResolvedValue(attachments)
  mockedTools.mockImplementation(
    async (_env: Env, upstreamId: string) => toolsByUpstream[upstreamId] ?? []
  )
}

const env = {} as Env

beforeEach(() => {
  vi.clearAllMocks()
})

describe('lintSkillBody', () => {
  it('flags a valid hyphenated-slug mangled ref with the native name', async () => {
    // The headline case: `up-ado` is kebab-case, which the old
    // underscore-only slug pattern never matched.
    setup([attach('up-ado', 'ado-id')], {
      'ado-id': [tool('ado-id', 'wit_work_item'), tool('ado-id', 'repo_file')]
    })
    const out = await lintSkillBody(env, 'sk', 'First call `up-ado__wit_work_item` to fetch it.')
    expect(out).toEqual([
      {
        kind: 'mangled_reference',
        reference: 'up-ado__wit_work_item',
        upstreamSlug: 'up-ado',
        toolName: 'wit_work_item'
      }
    ])
  })

  it('recovers the native name through the slug-prefix collapse', async () => {
    // Native `notion-search` collapses to the callable `notion__search`;
    // the finding must point back at the RAW native name to migrate to.
    setup([attach('notion', 'notion-id')], { 'notion-id': [tool('notion-id', 'notion-search')] })
    const out = await lintSkillBody(env, 'sk', 'Use `notion__search`.')
    expect(out).toEqual([
      {
        kind: 'mangled_reference',
        reference: 'notion__search',
        upstreamSlug: 'notion',
        toolName: 'notion-search'
      }
    ])
  })

  it('matches multi-hyphen slugs', async () => {
    setup([attach('up-yuki-ia-nl', 'y-id')], { 'y-id': [tool('y-id', 'list_nodes')] })
    const out = await lintSkillBody(env, 'sk', '`up-yuki-ia-nl__list_nodes`')
    expect(out).toEqual([
      {
        kind: 'mangled_reference',
        reference: 'up-yuki-ia-nl__list_nodes',
        upstreamSlug: 'up-yuki-ia-nl',
        toolName: 'list_nodes'
      }
    ])
  })

  it('flags an unknown tool on an attached upstream', async () => {
    setup([attach('up-ado', 'ado-id')], { 'ado-id': [tool('ado-id', 'wit_work_item')] })
    const out = await lintSkillBody(env, 'sk', 'Call `up-ado__does_not_exist`.')
    expect(out).toEqual([
      {
        kind: 'unknown_tool',
        reference: 'up-ado__does_not_exist',
        upstreamSlug: 'up-ado',
        toolName: 'does_not_exist'
      }
    ])
  })

  it('ignores <slug>__ shapes whose slug is not an attached upstream', async () => {
    setup([attach('up-ado', 'ado-id')], { 'ado-id': [tool('ado-id', 'repo_file')] })
    const out = await lintSkillBody(env, 'sk', 'Unrelated `process__id` and `foo__bar` text.')
    expect(out).toEqual([])
  })

  it('dedupes repeated references', async () => {
    setup([attach('up-ado', 'ado-id')], { 'ado-id': [tool('ado-id', 'repo_file')] })
    const out = await lintSkillBody(env, 'sk', '`up-ado__repo_file` … later `up-ado__repo_file`')
    expect(out).toHaveLength(1)
  })

  it('returns [] when the skill has no attachments', async () => {
    setup([], {})
    const out = await lintSkillBody(env, 'sk', 'Body mentioning `up-ado__wit_work_item`.')
    expect(out).toEqual([])
    expect(mockedTools).not.toHaveBeenCalled()
  })
})
