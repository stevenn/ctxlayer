/**
 * Archive pack/unpack for OKF bundles in the two supported formats: `zip`
 * (fflate) and `tar.gz` (hand-rolled tar → fflate gzip). Worker-side only.
 */

import { gunzipSync, gzipSync, unzipSync, zipSync } from 'fflate'
import { tarPack, tarUnpack } from './tar'

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
    const map = unzipSync(bytes)
    return Object.entries(map)
      .filter(([path]) => !path.endsWith('/')) // skip directory entries
      .map(([path, b]) => ({ path, bytes: b }))
  }
  return tarUnpack(gunzipSync(bytes))
}
