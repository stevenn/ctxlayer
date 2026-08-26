import { describe, it, expect } from 'vitest'
import {
  truncateDescription,
  perToolPointers,
  perToolAttachments,
  wholeUpstreamAttachments,
  wholeUpstreamPointers,
  summariseToolDescription,
  groupToolsByFamily,
  upstreamGuidance,
  type ToolAttachments,
  type UpstreamUserContext
} from './catalogue-views'
import { mangleToolName } from './tool-name'
import type { SkillForUpstreamRow } from '../db/queries/skill-attachments'
import type { DocForUpstreamRow } from '../db/queries/doc-attachments'
import type { UpstreamToolRow } from '../db/queries/upstream-tools'
import type { UpstreamServerRow } from '../db/queries/upstreams'

describe('truncateDescription', () => {
  it('leaves short strings untouched', () => {
    expect(truncateDescription('hello', 1024)).toBe('hello')
  })

  it('caps over-long strings with an ellipsis at the limit', () => {
    const out = truncateDescription('x'.repeat(2000), 10)
    expect(out).toHaveLength(10)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('perToolPointers', () => {
  const skill = (tool_name: string, slug: string): SkillForUpstreamRow =>
    ({ tool_name, slug, title: slug }) as SkillForUpstreamRow
  const doc = (tool_name: string, slug: string): DocForUpstreamRow =>
    ({ tool_name, slug, title: slug, doc_id: `id-${slug}` }) as DocForUpstreamRow

  it('groups skill + doc pointers by tool, merging both kinds', () => {
    const map = perToolPointers([skill('search', 'how-to-search')], [doc('search', 'search-doc')])
    expect(map.get('search')).toEqual([
      'skill `how-to-search` (get_skill)',
      'doc `search-doc` (get_doc)'
    ])
  })

  it('skips whole-upstream rows (empty tool_name)', () => {
    const map = perToolPointers([skill('', 'org-wide')], [doc('', 'org-doc')])
    expect(map.size).toBe(0)
  })
})

describe('wholeUpstreamPointers', () => {
  const skill = (tool_name: string, slug: string): SkillForUpstreamRow =>
    ({ tool_name, slug, title: slug }) as SkillForUpstreamRow
  const doc = (tool_name: string, slug: string): DocForUpstreamRow =>
    ({ tool_name, slug, title: slug, doc_id: `id-${slug}` }) as DocForUpstreamRow

  it('returns refs for whole-upstream rows, skills then docs', () => {
    const refs = wholeUpstreamPointers(
      [skill('', 'driverai-planning'), skill('', 'driverai-research')],
      [doc('', 'driver-overview')]
    )
    expect(refs).toEqual([
      'skill `driverai-planning`',
      'skill `driverai-research`',
      'doc `driver-overview`'
    ])
  })

  it('ignores per-tool rows (non-empty tool_name)', () => {
    const refs = wholeUpstreamPointers([skill('search', 'how-to-search')], [doc('search', 'sdoc')])
    expect(refs).toEqual([])
  })
})

describe('upstreamGuidance', () => {
  const skill = (slug: string): SkillForUpstreamRow =>
    ({ tool_name: '', slug, title: slug }) as SkillForUpstreamRow
  const row = (id: string, slug: string): UpstreamServerRow => ({ id, slug }) as UpstreamServerRow
  const ctx = (over: Partial<UpstreamUserContext>): UpstreamUserContext => ({
    rows: [],
    skillsByUpstream: new Map(),
    docsByUpstream: new Map(),
    ...over
  })
  const BIG = 100_000

  it('returns empty string when no upstream carries a whole-upstream attachment', () => {
    const out = upstreamGuidance(ctx({ rows: [row('u1', 'up-plain')] }), BIG)
    expect(out).toBe('')
  })

  it('emits a leading block: header, one line per upstream, trailing blank line', () => {
    const out = upstreamGuidance(
      ctx({
        rows: [row('u1', 'up-driver')],
        skillsByUpstream: new Map([['u1', [skill('sk-plan'), skill('sk-research')]]])
      }),
      BIG
    )
    expect(out.startsWith('**Org playbooks')).toBe(true)
    expect(out).toContain('- `up-driver`: skill `sk-plan`, skill `sk-research`')
    expect(out.endsWith('\n\n')).toBe(true)
  })

  it('collapses refs past the per-line cap into +N more', () => {
    const out = upstreamGuidance(
      ctx({
        rows: [row('u1', 'up-driver')],
        skillsByUpstream: new Map([
          ['u1', [skill('sk-a'), skill('sk-b'), skill('sk-c'), skill('sk-d'), skill('sk-e')]]
        ])
      }),
      BIG
    )
    expect(out).toContain('- `up-driver`: skill `sk-a`, skill `sk-b`, skill `sk-c` +2 more')
    expect(out).not.toContain('sk-d')
  })

  it('collapses whole upstreams into an overflow pointer when the budget is tight', () => {
    // Three skills per upstream keep each line longer than the overflow
    // pointer, so shaving the budget drops exactly the last line.
    const skillsFor = (u: string) => [
      skill(`sk-${u}-playbook-alpha`),
      skill(`sk-${u}-playbook-beta`),
      skill(`sk-${u}-playbook-gamma`)
    ]
    const tight = ctx({
      rows: [row('u1', 'up-driver'), row('u2', 'up-sentry'), row('u3', 'up-linear')],
      skillsByUpstream: new Map([
        ['u1', skillsFor('driver')],
        ['u2', skillsFor('sentry')],
        ['u3', skillsFor('linear')]
      ])
    })
    const full = upstreamGuidance(tight, BIG)
    const out = upstreamGuidance(tight, full.length - 10)
    expect(out.length).toBeLessThanOrEqual(full.length - 10)
    expect(out).toContain('- `up-driver`: skill `sk-driver-playbook-alpha`')
    expect(out).toContain('more upstream')
    expect(out).toContain('check `list_upstreams.attached_skills`.')
    expect(out).not.toContain('sk-linear-playbook')
    expect(out.endsWith('\n\n')).toBe(true)
  })
})

describe('summariseToolDescription', () => {
  it('returns empty string for null/empty', () => {
    expect(summariseToolDescription(null)).toBe('')
    expect(summariseToolDescription('')).toBe('')
    expect(summariseToolDescription('   ')).toBe('')
  })

  it('strips control characters and collapses whitespace/newlines to one line', () => {
    const out = summariseToolDescription('Read\x00 work\titems.\n\nUse  action.')
    expect(out).toBe('Read work items. Use action.')
  })

  it('keeps abbreviations intact (no first-sentence heuristic to mis-cut on "e.g.")', () => {
    const out = summariseToolDescription("Set a field, e.g. 'System.Title'. Then save.")
    expect(out).toBe("Set a field, e.g. 'System.Title'. Then save.")
  })

  it('caps over-long descriptions with an ellipsis at the limit', () => {
    const out = summariseToolDescription('x'.repeat(500), 200)
    expect(out).toHaveLength(200)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('groupToolsByFamily', () => {
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
  const noAtt = new Map<string, ToolAttachments>()

  it('groups by first-underscore family prefix, ungrouped ("") sorts last', () => {
    const groups = groupToolsByFamily(
      'up-ado',
      [
        tool('wit_work_item'),
        tool('wit_query'),
        tool('repo_branch'),
        tool('search') // no underscore → ungrouped
      ],
      noAtt
    )
    expect(groups.map((g) => g.family)).toEqual(['repo', 'wit', ''])
    // tools sort by name within a group
    expect(groups.find((g) => g.family === 'wit')?.tools.map((t) => t.name)).toEqual([
      'wit_query',
      'wit_work_item'
    ])
  })

  it('the callable name equals mangleToolName (drift guard)', () => {
    const groups = groupToolsByFamily('up-ado', [tool('wit_work_item')], noAtt)
    expect(groups[0]?.tools[0]?.call).toBe(mangleToolName('up-ado', 'wit_work_item'))
    expect(groups[0]?.tools[0]?.call).toBe('up-ado__wit_work_item')
    expect(groups[0]?.tools[0]?.name).toBe('wit_work_item')
  })

  it('collapses a redundant slug prefix before deriving the family', () => {
    // notion-search under slug "notion" collapses to "search" → ungrouped.
    const groups = groupToolsByFamily('notion', [tool('notion-search')], noAtt)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.family).toBe('')
    expect(groups[0]?.tools[0]).toMatchObject({ name: 'notion-search', call: 'notion__search' })
  })

  it('handles the __ escape in tool names', () => {
    const groups = groupToolsByFamily('up-x', [tool('foo__bar')], noAtt)
    expect(groups[0]?.family).toBe('foo')
    expect(groups[0]?.tools[0]?.call).toBe('up-x__foo_~_bar')
  })

  it('family filter narrows to one family (case-insensitive)', () => {
    const groups = groupToolsByFamily(
      'up-ado',
      [tool('wit_work_item'), tool('repo_branch')],
      noAtt,
      { family: 'WIT' }
    )
    expect(groups.map((g) => g.family)).toEqual(['wit'])
  })

  it('query filter matches name OR summary (case-insensitive)', () => {
    const groups = groupToolsByFamily(
      'up-ado',
      [
        tool('wit_work_item', 'Read work items'),
        tool('repo_branch', 'List branches'),
        tool('pipelines_build', 'Trigger a pipeline run')
      ],
      noAtt,
      { query: 'branch' }
    )
    // matches repo_branch by name; the others by neither name nor summary
    expect(groups.flatMap((g) => g.tools.map((t) => t.name))).toEqual(['repo_branch'])
  })

  it('always emits the attachment arrays (empty when none), and attaches per-tool refs', () => {
    const att = new Map<string, ToolAttachments>([
      ['wit_work_item', { skills: [{ slug: 'sk-wi', title: 'Work-item playbook' }], docs: [] }]
    ])
    const groups = groupToolsByFamily('up-ado', [tool('wit_work_item'), tool('wit_query')], att)
    const wit = groups.find((g) => g.family === 'wit')!.tools
    const withAtt = wit.find((t) => t.name === 'wit_work_item')!
    const without = wit.find((t) => t.name === 'wit_query')!
    expect(withAtt.attached_skills).toEqual([{ slug: 'sk-wi', title: 'Work-item playbook' }])
    expect(withAtt.attached_docs).toEqual([])
    // Field is always present (never undefined) so clients can rely on it.
    expect(without.attached_skills).toEqual([])
    expect(without.attached_docs).toEqual([])
  })
})

describe('perToolAttachments', () => {
  const skill = (tool_name: string, slug: string): SkillForUpstreamRow => ({
    skill_id: `id-${slug}`,
    slug,
    title: slug,
    tool_name,
    status: 'published'
  })
  const doc = (tool_name: string, slug: string): DocForUpstreamRow => ({
    doc_id: `id-${slug}`,
    slug,
    title: slug,
    tool_name
  })

  it('buckets per-tool refs by native tool name and structures them', () => {
    const m = perToolAttachments(
      [skill('wit_work_item', 'sk-a'), skill('wit_work_item', 'sk-b')],
      [doc('wit_work_item', 'd-a')]
    )
    expect(m.get('wit_work_item')).toEqual({
      skills: [
        { slug: 'sk-a', title: 'sk-a' },
        { slug: 'sk-b', title: 'sk-b' }
      ],
      docs: [{ id: 'id-d-a', slug: 'd-a', title: 'd-a' }]
    })
  })

  it('excludes whole-upstream attachments (tool_name === "")', () => {
    const m = perToolAttachments([skill('', 'sk-whole')], [doc('', 'd-whole')])
    expect(m.size).toBe(0)
  })
})

describe('wholeUpstreamAttachments', () => {
  const skill = (tool_name: string, slug: string): SkillForUpstreamRow => ({
    skill_id: `id-${slug}`,
    slug,
    title: slug,
    tool_name,
    status: 'published'
  })
  const doc = (tool_name: string, slug: string): DocForUpstreamRow => ({
    doc_id: `id-${slug}`,
    slug,
    title: slug,
    tool_name
  })

  it('keeps only tool_name==="" rows and structures them (mirror of list_upstreams)', () => {
    const out = wholeUpstreamAttachments(
      [skill('', 'sk-whole'), skill('wit_work_item', 'sk-pertool')],
      [doc('', 'd-whole'), doc('repo_file', 'd-pertool')]
    )
    expect(out.skills).toEqual([{ slug: 'sk-whole', title: 'sk-whole' }])
    expect(out.docs).toEqual([{ id: 'id-d-whole', slug: 'd-whole', title: 'd-whole' }])
  })

  it('returns empty arrays (always present) when nothing is whole-upstream', () => {
    const out = wholeUpstreamAttachments([skill('wit_query', 'sk-x')], [])
    expect(out).toEqual({ skills: [], docs: [] })
  })
})
