import { describe, it, expect } from 'vitest'
import { isAsyncTool, parseJobContent, hashJobKey } from './async-submit'
import type { UpstreamConnection } from '../db/queries/upstreams'

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
