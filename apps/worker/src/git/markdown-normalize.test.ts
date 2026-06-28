import { describe, it, expect } from 'vitest'
import { normalizeMarkdown } from './markdown-normalize'

describe('normalizeMarkdown — trivial whitespace', () => {
  it('CRLF→LF, strips trailing ws, collapses blank runs, single trailing newline', () => {
    expect(normalizeMarkdown('a  \r\nb\n\n\n\nc')).toBe('a\nb\n\nc\n')
  })
  it('drops a leading BOM and returns "" for blank input', () => {
    expect(normalizeMarkdown('﻿hi')).toBe('hi\n')
    expect(normalizeMarkdown('   \n\n')).toBe('')
  })
})

describe('normalizeMarkdown — hard-break re-wrap (the dominant churn)', () => {
  it('restores a BlockNote back-slash hard break to the original soft break', () => {
    // BlockNote emits `a\` + NL + ` b` for a soft-wrapped `a` / `b`.
    expect(normalizeMarkdown('a\\\n b\\\n c')).toBe('a\nb\nc\n')
  })
  it('is symmetric: normalize(source) === normalize(blocknote-roundtrip)', () => {
    const source = 'one two\nthree four\nfive six'
    const roundtrip = 'one two\\\n three four\\\n five six\n'
    expect(normalizeMarkdown(roundtrip)).toBe(normalizeMarkdown(source))
  })
  it('only dedents a continuation that follows a hard break', () => {
    // A leading space NOT preceded by a hard break is left alone.
    expect(normalizeMarkdown('plain\n leading-space line')).toBe('plain\n leading-space line\n')
  })
  it('leaves an escaped (even-count) trailing backslash intact', () => {
    expect(normalizeMarkdown('path C:\\\\\nnext')).toBe('path C:\\\\\nnext\n')
  })
})

describe('normalizeMarkdown — table recompression', () => {
  it('collapses per-column padding to a compact single-space form', () => {
    const padded = '| Col A       | Col B |\n| ----------- | ----- |\n| 1           | 2     |'
    expect(normalizeMarkdown(padded)).toBe('| Col A | Col B |\n| --- | --- |\n| 1 | 2 |\n')
  })
  it('is symmetric across paddings and idempotent on the compact form', () => {
    const a = '| a | b |\n|---|---|\n| 1 | 2 |'
    const b = '| a | b |\n| --------- | ----- |\n| 1 | 2 |'
    expect(normalizeMarkdown(a)).toBe(normalizeMarkdown(b))
    expect(normalizeMarkdown(normalizeMarkdown(a))).toBe(normalizeMarkdown(a))
  })
  it('preserves column alignment markers', () => {
    const t = '| L | C | R |\n| :-- | :-: | --: |\n| a | b | c |'
    expect(normalizeMarkdown(t)).toBe('| L | C | R |\n| :-- | :-: | --: |\n| a | b | c |\n')
  })
  it('does not treat a lone thematic break as a table separator', () => {
    expect(normalizeMarkdown('para text\n\n---\n\nmore')).toBe('para text\n\n---\n\nmore\n')
  })
})

describe('normalizeMarkdown — fenced code is never reformatted', () => {
  it('leaves a trailing backslash and a pipe-row inside a fence untouched', () => {
    const md = ['```sh', 'echo foo \\\\', 'bar', '| not | a table |', '| --- | --- |', '```'].join(
      '\n'
    )
    // The fence body must survive verbatim (plus the single trailing newline).
    expect(normalizeMarkdown(md)).toBe(`${md}\n`)
  })
})
