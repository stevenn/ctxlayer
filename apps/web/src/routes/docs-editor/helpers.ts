import { explain as explainBase } from '../../lib/explain'

// Stable per-user cursor color. HSL hue derived from a fast 32-bit
// hash of the userId, full saturation, mid lightness.
export function userColor(userId: string): string {
  let h = 0
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0
  const hue = ((h % 360) + 360) % 360
  return `hsl(${hue}, 70%, 50%)`
}

export function formatAbsolute(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

export function explain(err: unknown): string {
  return explainBase(err, {
    403: 'You do not have permission for this action.',
    // Write-back's only 422 is the HTML-round-trip guard.
    422: "This doc uses HTML the editor can't preserve, so write-back is disabled — edit it directly in git."
  })
}
