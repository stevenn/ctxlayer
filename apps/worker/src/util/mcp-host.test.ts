import { describe, expect, it } from 'vitest'
import type { Env } from '../env'
import { isMcpPathOnWrongHost } from './mcp-host'

const req = (url: string) => new Request(url)
const env = (over: Partial<Env> = {}): Env => over as Env

describe('isMcpPathOnWrongHost', () => {
  it('is a no-op when no dedicated MCP host is configured', () => {
    expect(isMcpPathOnWrongHost(req('https://ctxlayer.example/mcp'), env())).toBe(false)
    expect(isMcpPathOnWrongHost(req('https://ctxlayer.example/sse'), env({}))).toBe(false)
  })

  it('allows MCP paths ON the configured MCP host', () => {
    const e = env({ MCP_PUBLIC_URL: 'https://mcp.example' })
    expect(isMcpPathOnWrongHost(req('https://mcp.example/mcp'), e)).toBe(false)
    expect(isMcpPathOnWrongHost(req('https://mcp.example/sse'), e)).toBe(false)
    expect(isMcpPathOnWrongHost(req('https://mcp.example/cli/skills'), e)).toBe(false)
  })

  it('blocks MCP paths on a DIFFERENT host (the browser host)', () => {
    const e = env({ MCP_PUBLIC_URL: 'https://mcp.example' })
    expect(isMcpPathOnWrongHost(req('https://ctxlayer.example/mcp'), e)).toBe(true)
    expect(isMcpPathOnWrongHost(req('https://ctxlayer.example/mcp/messages'), e)).toBe(true)
    expect(isMcpPathOnWrongHost(req('https://ctxlayer.example/sse'), e)).toBe(true)
    expect(isMcpPathOnWrongHost(req('https://ctxlayer.example/cli/skills'), e)).toBe(true)
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
    expect(isMcpPathOnWrongHost(req('https://ctxlayer.example/sse-foo'), e)).toBe(false)
  })

  it('is a no-op when MCP_PUBLIC_URL is malformed', () => {
    const e = env({ MCP_PUBLIC_URL: 'not a url' })
    expect(isMcpPathOnWrongHost(req('https://ctxlayer.example/mcp'), e)).toBe(false)
  })
})
