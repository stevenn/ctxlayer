import { describe, expect, it } from 'vitest'
import { toUpstreamConnection, type UpstreamServerRow } from './upstreams'

function baseRow(overrides: Partial<UpstreamServerRow> = {}): UpstreamServerRow {
  return {
    id: 'u1',
    slug: 'notion',
    display_name: 'Notion',
    transport: 'streamable_http',
    url: 'https://mcp.notion.com/mcp',
    auth_strategy: 'user_bearer',
    auth_config: '{}',
    enabled: 1,
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides
  }
}

describe('toUpstreamConnection', () => {
  it('hydrates a happy-path streamable_http row', () => {
    const conn = toUpstreamConnection(baseRow())
    expect(conn.id).toBe('u1')
    expect(conn.slug).toBe('notion')
    expect(conn.transport).toBe('streamable_http')
    expect(conn.authStrategy).toBe('user_bearer')
    expect(conn.enabled).toBe(true)
    expect(conn.authConfig).toEqual({})
  })

  it('accepts the sse transport', () => {
    const conn = toUpstreamConnection(baseRow({ transport: 'sse' }))
    expect(conn.transport).toBe('sse')
  })

  it('rejects an unsupported transport', () => {
    // A row carrying any transport the worker cannot dial (legacy or forged)
    // must never be returned as a dialable connection. `stdio_daytona` is
    // used here only as an example of such a value.
    expect(() => toUpstreamConnection(baseRow({ transport: 'stdio_daytona' }))).toThrow(
      /unsupported_transport:stdio_daytona/
    )
  })

  it('parses a non-trivial auth_config JSON blob', () => {
    const conn = toUpstreamConnection(
      baseRow({
        auth_config: JSON.stringify({
          http: { headerName: 'X-Notion-Auth', headerPrefix: 'Token ' }
        })
      })
    )
    expect(conn.authConfig.http).toEqual({
      headerName: 'X-Notion-Auth',
      headerPrefix: 'Token '
    })
  })

  it('falls back to an empty config on malformed JSON', () => {
    const conn = toUpstreamConnection(baseRow({ auth_config: 'not json' }))
    expect(conn.authConfig).toEqual({})
  })

  it('reports enabled=false for disabled rows', () => {
    const conn = toUpstreamConnection(baseRow({ enabled: 0 }))
    expect(conn.enabled).toBe(false)
  })

  it('treats a NULL url as empty string (we never read it for stdio anyway)', () => {
    const conn = toUpstreamConnection(baseRow({ url: null }))
    expect(conn.url).toBe('')
  })
})
