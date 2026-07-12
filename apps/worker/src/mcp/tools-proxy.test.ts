import { describe, it, expect, vi } from 'vitest'
import {
  truncateDescription,
  truncationNotice,
  perToolPointers,
  wholeUpstreamPointers,
  summariseToolDescription,
  groupToolsByFamily,
  isTimeoutError,
  callWithHeartbeat,
  runUpstreamCall,
  isAsyncTool,
  parseJobContent,
  hashJobKey
} from './tools-proxy'
import { mangleToolName } from './tool-name'
import type { SkillForUpstreamRow } from '../db/queries/skill-attachments'
import type { DocForUpstreamRow } from '../db/queries/doc-attachments'
import type { UpstreamToolRow } from '../db/queries/upstream-tools'
import type { UpstreamConnection } from '../db/queries/upstreams'

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

describe('truncationNotice', () => {
  it('names the upstream/tool, the size, and the cap', () => {
    const notice = truncationNotice('driver', 'get_code_map', 1_400_000, 1_000_000)
    expect(notice).toContain('driver.get_code_map')
    expect(notice).toContain('1400000')
    expect(notice).toContain('1000000')
    // First-party guidance steering the agent to a narrower call.
    expect(notice.toLowerCase()).toContain('narrower scope')
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
      'skill `driverai-planning` (get_skill)',
      'skill `driverai-research` (get_skill)',
      'doc `driver-overview` (get_doc)'
    ])
  })

  it('ignores per-tool rows (non-empty tool_name)', () => {
    const refs = wholeUpstreamPointers([skill('search', 'how-to-search')], [doc('search', 'sdoc')])
    expect(refs).toEqual([])
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

  it('groups by first-underscore family prefix, ungrouped ("") sorts last', () => {
    const groups = groupToolsByFamily('up-ado', [
      tool('wit_work_item'),
      tool('wit_query'),
      tool('repo_branch'),
      tool('search') // no underscore → ungrouped
    ])
    expect(groups.map((g) => g.family)).toEqual(['repo', 'wit', ''])
    // tools sort by name within a group
    expect(groups.find((g) => g.family === 'wit')?.tools.map((t) => t.name)).toEqual([
      'wit_query',
      'wit_work_item'
    ])
  })

  it('the callable name equals mangleToolName (drift guard)', () => {
    const groups = groupToolsByFamily('up-ado', [tool('wit_work_item')])
    expect(groups[0]?.tools[0]?.call).toBe(mangleToolName('up-ado', 'wit_work_item'))
    expect(groups[0]?.tools[0]?.call).toBe('up-ado__wit_work_item')
    expect(groups[0]?.tools[0]?.name).toBe('wit_work_item')
  })

  it('collapses a redundant slug prefix before deriving the family', () => {
    // notion-search under slug "notion" collapses to "search" → ungrouped.
    const groups = groupToolsByFamily('notion', [tool('notion-search')])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.family).toBe('')
    expect(groups[0]?.tools[0]).toMatchObject({ name: 'notion-search', call: 'notion__search' })
  })

  it('handles the __ escape in tool names', () => {
    const groups = groupToolsByFamily('up-x', [tool('foo__bar')])
    expect(groups[0]?.family).toBe('foo')
    expect(groups[0]?.tools[0]?.call).toBe('up-x__foo_~_bar')
  })

  it('family filter narrows to one family (case-insensitive)', () => {
    const groups = groupToolsByFamily(
      'up-ado',
      [tool('wit_work_item'), tool('repo_branch')],
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
      { query: 'branch' }
    )
    // matches repo_branch by name; the others by neither name nor summary
    expect(groups.flatMap((g) => g.tools.map((t) => t.name))).toEqual(['repo_branch'])
  })
})

describe('isTimeoutError', () => {
  it('matches timeout-shaped messages', () => {
    expect(isTimeoutError(new Error('request timed out'))).toBe(true)
    expect(isTimeoutError(new Error('deadline exceeded'))).toBe(true)
    expect(isTimeoutError('Timeout while connecting')).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isTimeoutError(new Error('401 unauthorized'))).toBe(false)
  })
})

describe('callWithHeartbeat', () => {
  it('runs without pinging when the client sent no progressToken', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const out = await callWithHeartbeat({ sendNotification: send }, async () => 'result')
    expect(out).toBe('result')
    expect(send).not.toHaveBeenCalled()
  })

  it('runs without pinging when extra is undefined', async () => {
    expect(await callWithHeartbeat(undefined, async () => 42)).toBe(42)
  })

  it('pings progress on an interval while running, then stops on completion', async () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn().mockResolvedValue(undefined)
      let finish: (v: string) => void = () => {}
      const work = new Promise<string>((r) => {
        finish = r
      })
      const p = callWithHeartbeat(
        { _meta: { progressToken: 'tok-1' }, sendNotification: send },
        () => work
      )

      await vi.advanceTimersByTimeAsync(26_000)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls.at(0)?.[0]).toEqual({
        method: 'notifications/progress',
        params: { progressToken: 'tok-1', progress: 1, message: expect.any(String) }
      })

      await vi.advanceTimersByTimeAsync(25_000)
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls.at(1)?.[0]?.params.progress).toBe(2)

      finish('done')
      await expect(p).resolves.toBe('done')

      // Interval cleared on completion — no further pings.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(send).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the interval even when the call throws', async () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn().mockResolvedValue(undefined)
      const p = callWithHeartbeat(
        { _meta: { progressToken: 7 }, sendNotification: send },
        async () => {
          throw new Error('upstream boom')
        }
      )
      await expect(p).rejects.toThrow('upstream boom')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(send).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runUpstreamCall', () => {
  it('normalises a successful call to ok content', async () => {
    const out = await runUpstreamCall({
      slug: 'driver',
      toolName: 'x',
      run: async () => ({ content: [{ type: 'text', text: 'hi' }] })
    })
    expect(out.status).toBe('ok')
    expect(out.surface.isError).toBe(false)
    expect(out.surface.content[0]?.text).toBe('hi')
    expect(out.truncated).toBe(false)
  })

  it('classifies an isError result as error', async () => {
    const out = await runUpstreamCall({
      slug: 'driver',
      toolName: 'x',
      run: async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true })
    })
    expect(out.status).toBe('error')
    expect(out.surface.isError).toBe(true)
    expect(out.errorCode).toBeDefined()
  })

  it('replaces an oversized response with a truncation notice', async () => {
    const out = await runUpstreamCall({
      slug: 'driver',
      toolName: 'get_code_map',
      maxResponseBytes: 100,
      run: async () => ({ content: [{ type: 'text', text: 'x'.repeat(500) }] })
    })
    expect(out.truncated).toBe(true)
    expect(out.status).toBe('ok')
    expect(out.surface.content[0]?.text).toContain('relay cap')
  })

  it('maps a thrown timeout to status timeout', async () => {
    const out = await runUpstreamCall({
      slug: 'driver',
      toolName: 'gather_task_context',
      run: async () => {
        throw new Error('Request timed out')
      }
    })
    expect(out.status).toBe('timeout')
    expect(out.surface.isError).toBe(true)
    expect(out.surface.content[0]?.text).toContain('upstream_timeout')
  })

  it('sanitises a thrown error (no credential leak) and tags a ref', async () => {
    const out = await runUpstreamCall({
      slug: 'driver',
      toolName: 'x',
      run: async () => {
        throw new Error('failed Authorization: Bearer sk-secret-123')
      }
    })
    expect(out.status).toBe('error')
    expect(out.surface.content[0]?.text).not.toContain('sk-secret-123')
    expect(out.surface.content[0]?.text).toMatch(/ref=/)
  })
})

describe('isAsyncTool', () => {
  const conn = (asyncTools?: string[]) =>
    ({ authConfig: { asyncTools } }) as unknown as UpstreamConnection

  it('is true only for a native tool on the asyncTools list', () => {
    expect(isAsyncTool(conn(['gather_task_context']), 'gather_task_context')).toBe(true)
    expect(isAsyncTool(conn(['gather_task_context']), 'get_code_map')).toBe(false)
    expect(isAsyncTool(conn(undefined), 'gather_task_context')).toBe(false)
    expect(isAsyncTool(conn([]), 'gather_task_context')).toBe(false)
  })
})

describe('parseJobContent', () => {
  it('parses a stored content array back verbatim', () => {
    expect(parseJobContent('[{"type":"text","text":"hi"}]')).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('wraps a non-array / unparseable value as a text item', () => {
    expect(parseJobContent('not json')).toEqual([{ type: 'text', text: 'not json' }])
    expect(parseJobContent('"a string"')).toEqual([{ type: 'text', text: '"a string"' }])
  })
})

describe('hashJobKey', () => {
  it('is stable for identical inputs and differs on any change', async () => {
    const a = await hashJobKey('u1', 'ups', 'tool', '{"x":1}')
    const b = await hashJobKey('u1', 'ups', 'tool', '{"x":1}')
    const c = await hashJobKey('u1', 'ups', 'tool', '{"x":2}')
    const d = await hashJobKey('u2', 'ups', 'tool', '{"x":1}')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toBe(d)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})
