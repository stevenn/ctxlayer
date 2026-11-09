import { describe, expect, it } from 'vitest'
import type { Env } from '../env'
import { isMcpPathOnWrongHost, mcpResourceUrl } from './mcp-host'

const req = (url: string) => new Request(url)
const env = (over: Partial<Env> = {}): Env => over as Env

describe('isMcpPathOnWrongHost', () => {
  it('is a no-op when no dedicated MCP host is configured', () => {
    expect(isMcpPathOnWrongHost(req('https://ctxlayer.example/mcp'), env())).toBe(false)
  })

  it('allows MCP paths ON the configured MCP host', () => {
    const e = env({ MCP_PUBLIC_URL: 'https://mcp.example' })
    expect(isMcpPathOnWrongHost(req('https://mcp.example/mcp'), e)).toBe(false)
  })

  it('blocks MCP paths on a DIFFERENT host (the browser host)', () => {
    const e = env({ MCP_PUBLIC_URL: 'https://mcp.example' })
    expect(isMcpPathOnWrongHost(req('https://ctxlayer.example/mcp'), e)).toBe(true)
    expect(isMcpPathOnWrongHost(req('https://ctxlayer.example/mcp/messages'), e)).toBe(true)
  })

  it('no longer treats the removed /sse endpoint as MCP surface', () => {
    const e = env({ MCP_PUBLIC_URL: 'https://mcp.example' })
    expect(isMcpPathOnWrongHost(req('https://ctxlayer.example/sse'), e)).toBe(false)
  })

  it('does NOT block non-MCP paths on the browser host', () => {
    const e = env({ MCP_PUBLIC_URL: 'https://mcp.example' })
    for (const p of ['/', '/api/config', '/oauth/authorize', '/.well-known/x', '/app/mcp-setup']) {
      expect(isMcpPathOnWrongHost(req(`https://ctxlayer.example${p}`), e)).toBe(false)
    }
  })

  it('does not false-match paths that merely start with the same letters', () => {
    const e = env({ MCP_PUBLIC_URL: 'https://mcp.example' })
    expect(isMcpPathOnWrongHost(req('https://ctxlayer.example/mcp-setup'), e)).toBe(false)
  })

  it('is a no-op when MCP_PUBLIC_URL is malformed', () => {
    const e = env({ MCP_PUBLIC_URL: 'not a url' })
    expect(isMcpPathOnWrongHost(req('https://ctxlayer.example/mcp'), e)).toBe(false)
  })
})

describe('mcpResourceUrl', () => {
  it('uses the dedicated MCP host when one is configured', () => {
    const e = env({ MCP_PUBLIC_URL: 'https://mcp.example', PUBLIC_BASE_URL: 'https://app.example' })
    expect(mcpResourceUrl(e)).toBe('https://mcp.example/mcp')
  })

  it('falls back to PUBLIC_BASE_URL (an empty MCP_PUBLIC_URL counts as unset)', () => {
    expect(mcpResourceUrl(env({ PUBLIC_BASE_URL: 'https://app.example' }))).toBe('https://app.example/mcp')
    expect(mcpResourceUrl(env({ MCP_PUBLIC_URL: '', PUBLIC_BASE_URL: 'https://app.example' }))).toBe(
      'https://app.example/mcp'
    )
  })

  it('never doubles the slash when the base carries a trailing one', () => {
    expect(mcpResourceUrl(env({ PUBLIC_BASE_URL: 'https://app.example/' }))).toBe('https://app.example/mcp')
  })
})
