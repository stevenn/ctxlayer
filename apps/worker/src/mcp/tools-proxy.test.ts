import { describe, it, expect, vi } from 'vitest'
import {
  truncateDescription,
  truncationNotice,
  perToolPointers,
  wholeUpstreamPointers,
  isTimeoutError,
  callWithHeartbeat
} from './tools-proxy'
import type { SkillForUpstreamRow } from '../db/queries/skill-attachments'
import type { DocForUpstreamRow } from '../db/queries/doc-attachments'

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
