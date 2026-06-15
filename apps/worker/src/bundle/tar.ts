/**
 * Minimal USTAR tar pack/unpack — deterministic, dependency-free, workerd-safe.
 * Enough for OKF bundles: regular files only, UTF-8 paths up to 255 bytes via
 * the ustar name(100)/prefix(155) split. mtime is fixed to 0 so the same
 * bundle packs byte-identically.
 */

const BLOCK = 512
const ENC = new TextEncoder()
const DEC = new TextDecoder()

export interface TarEntry {
  path: string
  bytes: Uint8Array
}

export function tarPack(entries: TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const e of entries) {
    blocks.push(header(e.path, e.bytes.length))
    blocks.push(e.bytes)
    const pad = (BLOCK - (e.bytes.length % BLOCK)) % BLOCK
    if (pad) blocks.push(new Uint8Array(pad))
  }
  blocks.push(new Uint8Array(BLOCK * 2)) // two zero blocks terminate the archive
  return concat(blocks)
}

export function tarUnpack(bytes: Uint8Array): TarEntry[] {
  const out: TarEntry[] = []
  let off = 0
  while (off + BLOCK <= bytes.length) {
    const h = bytes.subarray(off, off + BLOCK)
    if (isZeroBlock(h)) break
    const name = readStr(h, 0, 100)
    const prefix = readStr(h, 345, 155)
    const path = prefix ? `${prefix}/${name}` : name
    const size = parseOctal(h, 124, 12)
    const typeflag = h[156]
    off += BLOCK
    const content = bytes.subarray(off, off + size)
    off += Math.ceil(size / BLOCK) * BLOCK
    // typeflag '0' (0x30) or NUL = regular file; skip dirs / others.
    if (typeflag === 0x30 || typeflag === 0) out.push({ path, bytes: content.slice() })
  }
  return out
}

function header(path: string, size: number): Uint8Array {
  const h = new Uint8Array(BLOCK)
  let name = path
  let prefix = ''
  if (ENC.encode(path).length > 100) {
    const i = path.lastIndexOf('/')
    if (i > 0) {
      prefix = path.slice(0, i)
      name = path.slice(i + 1)
    }
  }
  writeStr(h, 0, name, 100)
  writeStr(h, 100, '0000644', 8) // mode
  writeStr(h, 108, '0000000', 8) // uid
  writeStr(h, 116, '0000000', 8) // gid
  writeStr(h, 124, `${size.toString(8).padStart(11, '0')}\0`, 12) // size (octal)
  writeStr(h, 136, '00000000000\0', 12) // mtime 0 (deterministic)
  for (let i = 148; i < 156; i++) h[i] = 0x20 // checksum field spaces while summing
  h[156] = 0x30 // typeflag '0' = regular file
  writeStr(h, 257, 'ustar\0', 6) // magic
  h[263] = 0x30
  h[264] = 0x30 // version "00"
  if (prefix) writeStr(h, 345, prefix, 155)
  // Checksum: sum of all header bytes (field counted as spaces), 6 octal + NUL + space.
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += h[i] ?? 0
  writeStr(h, 148, `${sum.toString(8).padStart(6, '0')}\0`, 7)
  h[155] = 0x20
  return h
}

function writeStr(buf: Uint8Array, offset: number, value: string, len: number): void {
  const b = ENC.encode(value)
  buf.set(b.subarray(0, len), offset)
}

function readStr(buf: Uint8Array, offset: number, len: number): string {
  const slice = buf.subarray(offset, offset + len)
  let end = slice.indexOf(0)
  if (end === -1) end = len
  return DEC.decode(slice.subarray(0, end))
}

function parseOctal(buf: Uint8Array, offset: number, len: number): number {
  const s = readStr(buf, offset, len).trim()
  return s ? Number.parseInt(s, 8) : 0
}

function isZeroBlock(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false
  return true
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
