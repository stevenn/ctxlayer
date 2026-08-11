/**
 * Archive pack/unpack for OKF bundles in the two supported formats: `zip`
 * (fflate) and `tar.gz` (hand-rolled tar → fflate gzip). Worker-side only.
 */

import { Gunzip, gzipSync, unzipSync, zipSync } from 'fflate'
import { tarPack, tarUnpack } from './tar'

/**
 * Total decompressed-bytes cap for an uploaded archive. gzip/deflate can
 * exceed 1000:1, so a small crafted upload could otherwise exhaust worker
 * memory before the MAX_DOCS count cap (which runs AFTER decompression)
 * ever sees it. Generous vs. the ~200-doc import cap; a legitimate bundle
 * never approaches it.
 */
export const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024

function archiveTooLarge(): Error {
  return new Error(`decompressed archive exceeds the ${MAX_DECOMPRESSED_BYTES}-byte cap`)
}

/** Streaming gunzip that aborts once output crosses the cap — never trusts
 * the (attacker-controlled) gzip size trailer for allocation. */
function gunzipCapped(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = []
  let total = 0
  const gz = new Gunzip((chunk) => {
    total += chunk.byteLength
    if (total > MAX_DECOMPRESSED_BYTES) throw archiveTooLarge()
    chunks.push(chunk)
  })
  gz.push(bytes, true)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

export type BundleFormat = 'tar.gz' | 'zip'

export interface BundleFile {
  path: string
  bytes: Uint8Array
}

export function isBundleFormat(s: string): s is BundleFormat {
  return s === 'tar.gz' || s === 'zip'
}

/** Content-Type + file extension for a download response. */
export const FORMAT_META: Record<BundleFormat, { ext: string; contentType: string }> = {
  'tar.gz': { ext: 'tar.gz', contentType: 'application/gzip' },
  zip: { ext: 'zip', contentType: 'application/zip' }
}

export function packArchive(files: BundleFile[], format: BundleFormat): Uint8Array {
  if (format === 'zip') {
    const map: Record<string, Uint8Array> = {}
    for (const f of files) map[f.path] = f.bytes
    return zipSync(map, { level: 6 })
  }
  return gzipSync(tarPack(files), { level: 6, mtime: 0 })
}

export function unpackArchive(bytes: Uint8Array, format: BundleFormat): BundleFile[] {
  if (format === 'zip') {
    // Sum the central directory's declared sizes and refuse past the cap
    // (a lying header that inflates bigger than declared makes fflate error
    // on its own). The filter runs per entry before inflation.
    let declared = 0
    const map = unzipSync(bytes, {
      filter: (f) => {
        declared += f.originalSize
        if (declared > MAX_DECOMPRESSED_BYTES) throw archiveTooLarge()
        return true
      }
    })
    return Object.entries(map)
      .filter(([path]) => !path.endsWith('/')) // skip directory entries
      .map(([path, b]) => ({ path, bytes: b }))
  }
  return tarUnpack(gunzipCapped(bytes))
}
