import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_SLUGS } from '@ctxlayer/shared'
import { BUILTIN_INPUT_SHAPES, builtinInputJsonSchema } from './builtin-schemas'

/**
 * The built-in input schemas are the SINGLE source feeding both the MCP
 * registration and the `/api/tools` feed (via `builtinInputJsonSchema`).
 * These pin the JSON Schema the SPA renders so it can't drift from the zod
 * shape the agent is validated against.
 */
describe('builtin-schemas', () => {
  it('every input-shape key is a real built-in tool', () => {
    for (const name of Object.keys(BUILTIN_INPUT_SHAPES)) {
      expect(BUILTIN_TOOL_SLUGS).toContain(name)
    }
  })

  it('describe_upstream: slug required; family/query optional', () => {
    const s = builtinInputJsonSchema('describe_upstream')
    expect(s).toBeDefined()
    const props = (s as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props).sort()).toEqual(['family', 'query', 'slug'])
    expect((s as { required: string[] }).required).toEqual(['slug'])
  })

  it('get_doc / get_skill: a single required id/slug', () => {
    expect((builtinInputJsonSchema('get_doc') as { required: string[] }).required).toEqual(['id'])
    expect((builtinInputJsonSchema('get_skill') as { required: string[] }).required).toEqual(['slug'])
  })

  it('search_docs: query required; k bounded; scope optional', () => {
    const s = builtinInputJsonSchema('search_docs') as {
      required: string[]
      properties: { k: { type: string; maximum: number }; scope: unknown }
    }
    expect(s.required).toEqual(['query'])
    expect(s.properties.k.type).toBe('integer')
    expect(s.properties.k.maximum).toBe(50)
    expect(s.properties.scope).toBeDefined()
  })

  it('active_users: optional window only, no required key', () => {
    const s = builtinInputJsonSchema('active_users') as {
      properties: Record<string, unknown>
      required?: string[]
    }
    expect(Object.keys(s.properties)).toEqual(['window'])
    expect(s.required).toBeUndefined()
  })

  it('parameterless built-ins yield no schema', () => {
    for (const name of ['whoami', 'list_my_context', 'list_upstreams', 'list_skills']) {
      expect(builtinInputJsonSchema(name)).toBeUndefined()
    }
  })
})
