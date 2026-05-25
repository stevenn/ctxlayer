import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { jsonSchemaToZod } from './json-schema-to-zod'

describe('jsonSchemaToZod', () => {
  it('returns a shape (record of zod schemas) for object roots', () => {
    const { shape, zod } = jsonSchemaToZod({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    })
    expect(shape).not.toBeNull()
    expect(shape!.name).toBeDefined()
    // zod fallback parses the object too
    expect(zod.parse({ name: 'alice' })).toEqual({ name: 'alice' })
  })

  it('treats objects without explicit type but with properties as objects', () => {
    const { shape } = jsonSchemaToZod({
      properties: { ok: { type: 'boolean' } }
    })
    expect(shape).not.toBeNull()
  })

  it('marks non-required fields as optional', () => {
    const { shape } = jsonSchemaToZod({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'string' }
      },
      required: ['a']
    })
    const obj = z.object(shape!)
    expect(obj.parse({ a: 'x' })).toEqual({ a: 'x' })
    expect(obj.parse({ a: 'x', b: 'y' })).toEqual({ a: 'x', b: 'y' })
    expect(() => obj.parse({})).toThrow()
  })

  it('passes through unknown properties (object root)', () => {
    const { zod } = jsonSchemaToZod({
      type: 'object',
      properties: { known: { type: 'string' } }
    })
    expect(zod.parse({ known: 'x', extra: 42 })).toEqual({ known: 'x', extra: 42 })
  })

  it('returns no shape for non-object roots; falls back to plain zod', () => {
    const { shape, zod } = jsonSchemaToZod({ type: 'string' })
    expect(shape).toBeNull()
    expect(zod.parse('hi')).toBe('hi')
    expect(() => zod.parse(42)).toThrow()
  })

  it('emits z.enum for string enums', () => {
    const { zod } = jsonSchemaToZod({ type: 'string', enum: ['a', 'b', 'c'] })
    expect(zod.parse('a')).toBe('a')
    expect(() => zod.parse('d')).toThrow()
  })

  it('emits a union for mixed-type enums', () => {
    const { zod } = jsonSchemaToZod({ enum: [1, 'two', true] })
    expect(zod.parse(1)).toBe(1)
    expect(zod.parse('two')).toBe('two')
    expect(zod.parse(true)).toBe(true)
    expect(() => zod.parse('three')).toThrow()
  })

  it('emits z.literal for const', () => {
    const { zod } = jsonSchemaToZod({ const: 'fixed' })
    expect(zod.parse('fixed')).toBe('fixed')
    expect(() => zod.parse('other')).toThrow()
  })

  it('integer narrows to int', () => {
    const { zod } = jsonSchemaToZod({ type: 'integer' })
    expect(zod.parse(3)).toBe(3)
    expect(() => zod.parse(3.14)).toThrow()
  })

  it('arrays use the items schema', () => {
    const { zod } = jsonSchemaToZod({
      type: 'array',
      items: { type: 'string' }
    })
    expect(zod.parse(['a', 'b'])).toEqual(['a', 'b'])
    expect(() => zod.parse(['a', 1])).toThrow()
  })

  it('tuple-style items takes the first entry', () => {
    const { zod } = jsonSchemaToZod({
      type: 'array',
      items: [{ type: 'string' }, { type: 'number' }]
    })
    expect(zod.parse(['a'])).toEqual(['a'])
  })

  it('arrays without items accept anything', () => {
    const { zod } = jsonSchemaToZod({ type: 'array' })
    expect(zod.parse([1, 'two', true])).toEqual([1, 'two', true])
  })

  it('allOf merges object subschemas', () => {
    const { zod } = jsonSchemaToZod({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] }
      ]
    })
    expect(zod.parse({ a: 'x', b: 1 })).toEqual({ a: 'x', b: 1 })
    expect(() => zod.parse({ a: 'x' })).toThrow()
  })

  it('oneOf becomes a union', () => {
    const { zod } = jsonSchemaToZod({
      oneOf: [{ type: 'string' }, { type: 'number' }]
    })
    expect(zod.parse('hi')).toBe('hi')
    expect(zod.parse(7)).toBe(7)
    expect(() => zod.parse(true)).toThrow()
  })

  it('falls back to z.any() for unknown types', () => {
    const { zod } = jsonSchemaToZod({ type: 'unknown-type' })
    expect(zod.parse({ anything: 1 })).toEqual({ anything: 1 })
  })

  it('multi-type arrays become a union', () => {
    const { zod } = jsonSchemaToZod({ type: ['string', 'number'] })
    expect(zod.parse('a')).toBe('a')
    expect(zod.parse(2)).toBe(2)
    expect(() => zod.parse(true)).toThrow()
  })

  it('null type accepts only null', () => {
    const { zod } = jsonSchemaToZod({ type: 'null' })
    expect(zod.parse(null)).toBeNull()
    expect(() => zod.parse(undefined)).toThrow()
  })
})
