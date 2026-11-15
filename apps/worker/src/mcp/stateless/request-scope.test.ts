import { describe, expect, it } from 'vitest'
import { requestScope } from './request-scope'

const req = (headers: Record<string, string>) =>
  new Request('https://mcp.example/mcp', { method: 'POST', headers })

describe('requestScope', () => {
  it('builds everything when the request names no method', () => {
    expect(requestScope(undefined)).toEqual({ family: 'all', method: null, toolName: null })
    expect(requestScope(req({})).family).toBe('all')
    expect(requestScope(req({ 'mcp-method': '   ' })).family).toBe('all')
  })

  it('recognises discover', () => {
    expect(requestScope(req({ 'mcp-method': 'server/discover' }))).toEqual({
      family: 'discover',
      method: 'server/discover',
      toolName: null
    })
  })

  it('narrows a tool call to the named tool, and a list to all tools', () => {
    expect(
      requestScope(req({ 'mcp-method': 'tools/call', 'mcp-name': 'up-linear__get_issue' }))
    ).toEqual({ family: 'tools', method: 'tools/call', toolName: 'up-linear__get_issue' })
    expect(requestScope(req({ 'mcp-method': 'tools/list' }))).toEqual({
      family: 'tools',
      method: 'tools/list',
      toolName: null
    })
  })

  it('a tool call that names no tool falls back to every tool', () => {
    expect(requestScope(req({ 'mcp-method': 'tools/call' })).toolName).toBeNull()
  })

  it.each([
    ['prompts/list', 'prompts'],
    ['prompts/get', 'prompts'],
    ['resources/list', 'resources'],
    ['resources/read', 'resources'],
    ['resources/templates/list', 'resources']
  ])('maps %s to the %s family', (method, family) => {
    expect(requestScope(req({ 'mcp-method': method })).family).toBe(family)
  })

  it('builds everything for a method it does not know', () => {
    expect(requestScope(req({ 'mcp-method': 'completion/complete' })).family).toBe('all')
  })
})
