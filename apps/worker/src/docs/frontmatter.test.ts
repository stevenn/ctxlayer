import { describe, expect, it } from 'vitest'
import { emitFrontmatter, parseFrontmatter, splitFrontmatter } from '@ctxlayer/shared'

const SAMPLE = `---
type: Playbook
title: Deploy Guide
description: How we ship the worker.
tags:
  - deploy
  - ops
okf_version: "0.1"
owner: platform-team
---

# Deploy Guide

Body text here.
`

describe('splitFrontmatter', () => {
  it('separates the fenced block from the body', () => {
    const { raw, body } = splitFrontmatter(SAMPLE)
    expect(raw).toContain('type: Playbook')
    expect(body.startsWith('# Deploy Guide')).toBe(true)
  })

  it('returns null raw + full body when there is no frontmatter', () => {
    const { raw, body } = splitFrontmatter('# Just a doc\n\ntext')
    expect(raw).toBeNull()
    expect(body).toBe('# Just a doc\n\ntext')
  })

  it('does not treat a mid-document --- (hr) as frontmatter', () => {
    const { raw } = splitFrontmatter('# Title\n\n---\n\nmore')
    expect(raw).toBeNull()
  })
})

describe('parseFrontmatter', () => {
  it('reads the well-known fields, including a block tag list', () => {
    const { known } = parseFrontmatter(SAMPLE)
    expect(known.type).toBe('Playbook')
    expect(known.title).toBe('Deploy Guide')
    expect(known.description).toBe('How we ship the worker.')
    expect(known.tags).toEqual(['deploy', 'ops'])
  })

  it('reads an inline tag list', () => {
    const { known } = parseFrontmatter('---\ntags: [a, "b c", d]\n---\nbody')
    expect(known.tags).toEqual(['a', 'b c', 'd'])
  })

  it('reads a scalar tag (string, not a list) as a single-element list', () => {
    expect(parseFrontmatter('---\ntags: "storytime"\n---\nbody').known.tags).toEqual(['storytime'])
    expect(parseFrontmatter('---\ntags: storytime\n---\nbody').known.tags).toEqual(['storytime'])
  })

  it('reads a block-scalar description without corrupting it', () => {
    const { known } = parseFrontmatter('---\ndescription: |\n  line one\n  line two\n---\nbody')
    expect(known.description).toBe('line one\nline two\n')
  })

  it('ignores trailing comments on a scalar value', () => {
    expect(parseFrontmatter('---\ntype: Document # the kind\n---\nbody').known.type).toBe('Document')
  })

  it('handles a flow list with a comma inside a quoted item', () => {
    expect(parseFrontmatter('---\ntags: ["a, b", c]\n---\nbody').known.tags).toEqual(['a, b', 'c'])
  })
})

describe('emitFrontmatter', () => {
  it('preserves unknown keys while overlaying managed fields', () => {
    const { raw } = splitFrontmatter(SAMPLE)
    const out = emitFrontmatter(
      { type: 'Playbook', title: 'New Title', description: null, resource: null, tags: ['deploy'] },
      raw
    )
    // managed field re-emitted from the override
    expect(out).toContain('title: New Title')
    // cleared managed field dropped
    expect(out).not.toContain('description:')
    // unknown keys carried through verbatim
    expect(out).toContain('okf_version: "0.1"')
    expect(out).toContain('owner: platform-team')
    // tags re-emitted as a block list
    expect(out).toContain('tags:\n  - deploy')
  })

  it('leaves a key untouched in the raw block when it is not in fields (unmanaged)', () => {
    // timestamp absent from fields → preserved from raw verbatim
    const out = emitFrontmatter({ title: 'T' }, 'timestamp: 2020-01-01T00:00:00Z\nfoo: bar')
    expect(out).toContain('timestamp: 2020-01-01T00:00:00Z')
    expect(out).toContain('foo: bar')
  })

  it('quotes values that would otherwise be mis-parsed as YAML (round-trips)', () => {
    const out = emitFrontmatter({ title: 'a: b #c' })
    expect(parseFrontmatter(`${out}body`).known.title).toBe('a: b #c')
  })

  it('returns empty string when there is nothing to emit', () => {
    expect(emitFrontmatter({ description: null }, null)).toBe('')
  })

  it('round-trips a parsed block back into parseable frontmatter', () => {
    const { known, raw } = parseFrontmatter(SAMPLE)
    const out = emitFrontmatter(
      {
        type: known.type ?? null,
        title: known.title ?? null,
        description: known.description ?? null,
        tags: known.tags ?? []
      },
      raw
    )
    const reparsed = parseFrontmatter(out + 'body')
    expect(reparsed.known.type).toBe('Playbook')
    expect(reparsed.known.title).toBe('Deploy Guide')
    expect(reparsed.known.tags).toEqual(['deploy', 'ops'])
  })
})
