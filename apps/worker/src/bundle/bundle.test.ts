import { describe, expect, it } from 'vitest'
import { packArchive, unpackArchive } from './archive'
import { generateIndexMd, generateLogMd, isReservedFile, readOkfVersion } from './reserved'
import { tarPack, tarUnpack } from './tar'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const byPath = (files: { path: string; bytes: Uint8Array }[]) =>
  new Map(files.map((f) => [f.path, dec(f.bytes)]))

describe('tar', () => {
  it('round-trips files, padding to 512, incl. a long path via prefix split', () => {
    const longPath = `${'dir/'.repeat(28)}deep.md` // > 100 bytes, dir part < 155 (ustar prefix)
    const files = [
      { path: 'a.md', bytes: enc('hello') },
      { path: 'dir/sub/b.md', bytes: enc('world '.repeat(200)) }, // spans multiple blocks
      { path: longPath, bytes: enc('x') }
    ]
    const packed = tarPack(files)
    expect(packed.length % 512).toBe(0)
    const out = byPath(tarUnpack(packed))
    expect(out.get('a.md')).toBe('hello')
    expect(out.get('dir/sub/b.md')).toBe('world '.repeat(200))
    expect(out.get(longPath)).toBe('x')
  })
})

describe('archive', () => {
  for (const format of ['tar.gz', 'zip'] as const) {
    it(`round-trips ${format} with nested paths`, () => {
      const files = [
        { path: 'index.md', bytes: enc('# Contents') },
        { path: 'specs/api/auth.md', bytes: enc('# Auth\n\nbody') }
      ]
      const out = byPath(unpackArchive(packArchive(files, format), format))
      expect(out.get('index.md')).toBe('# Contents')
      expect(out.get('specs/api/auth.md')).toBe('# Auth\n\nbody')
    })
  }
})

describe('reserved files', () => {
  it('recognizes index.md / log.md at any level', () => {
    expect(isReservedFile('index.md')).toBe(true)
    expect(isReservedFile('a/b/log.md')).toBe(true)
    expect(isReservedFile('a/auth.md')).toBe(false)
  })

  it('generates index.md with okf_version + a contents list, and reads it back', () => {
    const idx = generateIndexMd([
      { relPath: 'api/auth.md', title: 'Auth', description: 'How to auth' }
    ])
    expect(idx).toContain('okf_version: "0.1"')
    expect(idx).toContain('* [Auth](api/auth.md) - How to auth')
    expect(readOkfVersion(idx)).toBe('0.1')
  })

  it('generates a date-grouped log.md, newest first', () => {
    const log = generateLogMd([
      { date: '2026-05-01', text: 'old' },
      { date: '2026-06-01', text: 'new' }
    ])
    expect(log.indexOf('## 2026-06-01')).toBeLessThan(log.indexOf('## 2026-05-01'))
    expect(log).toContain('* **Update**: new')
  })
})
