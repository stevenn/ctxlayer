import { ApiError } from '../../lib/api/core'
import { explain as explainBase } from '../../lib/explain'

// Stable per-user cursor color. HSL hue derived from a fast 32-bit
// hash of the userId, full saturation, mid lightness.
export function userColor(userId: string): string {
  let h = 0
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0
  const hue = ((h % 360) + 360) % 360
  return `hsl(${hue}, 70%, 50%)`
}

export function explain(err: unknown): string {
  return explainBase(err, {
    403: 'You do not have permission for this action.',
    // Write-back 422s: the HTML-round-trip guard, or the dropped-oversize-
    // frontmatter guard — branch on the machine code.
    422: (e: ApiError) =>
      (e.body as { error?: string } | null)?.error === 'frontmatter_dropped'
        ? 'This doc was imported with a frontmatter block too large to preserve, so write-back would strip it — edit it directly in git.'
        : "This doc uses HTML the editor can't preserve, so write-back is disabled — edit it directly in git."
  })
}
