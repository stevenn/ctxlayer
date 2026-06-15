import { z } from 'zod'
import { request } from './core'

export type BundleFormat = 'tar.gz' | 'zip'

/** Download URL for a bundle export (GET, cookie-auth — use in a link/anchor). */
export function bundleExportUrl(root: string, format: BundleFormat): string {
  const qs = new URLSearchParams({ root: root || '/', format })
  return `/api/bundles/export?${qs}`
}

const ImportBundleResult = z.object({
  created: z.number(),
  skipped: z.number(),
  okfVersion: z.string().nullable(),
  errors: z.array(z.string())
})
export type ImportBundleResult = z.infer<typeof ImportBundleResult>

/** POST an archive (tar.gz / zip) to graft its docs under `target` (or root). */
export function importBundle(
  file: Blob,
  opts: { target?: string; format: BundleFormat }
): Promise<ImportBundleResult> {
  const qs = new URLSearchParams({ format: opts.format })
  if (opts.target) qs.set('target', opts.target)
  return request(`/api/bundles/import?${qs}`, (b) => ImportBundleResult.parse(b), {
    method: 'POST',
    body: file,
    headers: { 'content-type': 'application/octet-stream' }
  })
}
