import { describe, expect, it } from 'vitest'
import { canonicalHash, canonicalise } from './schema-diff'

/**
 * The canonicaliser drives the upstream-tools staleness flag. False
 * positives here mean spurious "schema changed" warnings on the admin
 * page; false negatives mean missed real changes. Both regress
 * operator trust.
 */
describe('canonicalise', () => {
  it('produces stable output across object key order', () => {
    const a = { type: 'object', properties: { x: { type: 'string' } } }
    const b = { properties: { x: { type: 'string' } }, type: 'object' }
    expect(canonicalise(a)).toBe(canonicalise(b))
  })

  it('strips cosmetic keys (description / title / examples)', () => {
    const before = { type: 'object', properties: { x: { type: 'string' } } }
    const afterDescription = {
      ...before,
      description: 'edited copy',
      title: 'My Tool'
    }
    expect(canonicalise(before)).toBe(canonicalise(afterDescription))

    const withNestedDesc = {
      type: 'object',
      properties: { x: { type: 'string', description: 'a value', examples: ['hi'] } }
    }
    const withoutNested = {
      type: 'object',
      properties: { x: { type: 'string' } }
    }
    expect(canonicalise(withNestedDesc)).toBe(canonicalise(withoutNested))
  })

  it('sorts set-like arrays (required, enum)', () => {
    const a = { required: ['a', 'b', 'c'] }
    const b = { required: ['c', 'a', 'b'] }
    expect(canonicalise(a)).toBe(canonicalise(b))

    const e1 = { enum: ['red', 'green', 'blue'] }
    const e2 = { enum: ['blue', 'green', 'red'] }
    expect(canonicalise(e1)).toBe(canonicalise(e2))
  })

  it('normalises type: ["X"] ↔ type: "X"', () => {
    const a = { type: 'string' }
    const b = { type: ['string'] }
    expect(canonicalise(a)).toBe(canonicalise(b))
  })

  it('preserves ordering on non-set-like arrays (items, allOf, etc.)', () => {
    const a = { items: ['x', 'y'] }
    const b = { items: ['y', 'x'] }
    expect(canonicalise(a)).not.toBe(canonicalise(b))
  })

  it('still detects real contract changes', () => {
    const base = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    }
    const addProp = {
      ...base,
      properties: { ...base.properties, age: { type: 'number' } }
    }
    const newRequired = { ...base, required: ['name', 'age'] }
    const typeChange = {
      ...base,
      properties: { name: { type: 'number' } }
    }
    expect(canonicalise(base)).not.toBe(canonicalise(addProp))
    expect(canonicalise(base)).not.toBe(canonicalise(newRequired))
    expect(canonicalise(base)).not.toBe(canonicalise(typeChange))
  })

  it('treats $comment / $id / readOnly / writeOnly / deprecated as cosmetic', () => {
    const a = { type: 'object' }
    const b = {
      type: 'object',
      $comment: 'todo: tighten',
      $id: 'https://example.com/foo',
      readOnly: true,
      writeOnly: false,
      deprecated: true
    }
    expect(canonicalise(a)).toBe(canonicalise(b))
  })

  it('does NOT strip default (default change is observable to the agent)', () => {
    const a = { properties: { x: { type: 'string' } } }
    const b = { properties: { x: { type: 'string', default: 'fallback' } } }
    expect(canonicalise(a)).not.toBe(canonicalise(b))
  })
})

describe('canonicalHash', () => {
  it('returns the same 64-char hex digest for canonically equal schemas', async () => {
    const a = { type: 'object', properties: { x: { type: 'string', description: 'foo' } } }
    const b = { properties: { x: { type: 'string', description: 'bar' } }, type: 'object' }
    const ha = await canonicalHash(a)
    const hb = await canonicalHash(b)
    expect(ha).toBe(hb)
    expect(ha).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns different digests when properties differ', async () => {
    const a = { properties: { x: { type: 'string' } } }
    const b = { properties: { y: { type: 'string' } } }
    expect(await canonicalHash(a)).not.toBe(await canonicalHash(b))
  })
})
