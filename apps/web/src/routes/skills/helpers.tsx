import type { ApiError } from '../../lib/api'
import { explain as explainBase } from '../../lib/explain'

export function explain(err: unknown): string {
  return explainBase(err, {
    403: "You don't have permission to change this skill.",
    404: 'Not found.',
    409: 'Slug already taken — pick another.',
    400: (e) => bodyMessage(e) ?? 'Server rejected the request.'
  })
}

// Preferred body-message order for this screen: hint → message → error.
function bodyMessage(err: ApiError): string | null {
  const body = err.body as { error?: string; hint?: string; message?: string } | null | undefined
  if (!body || typeof body !== 'object') return null
  if (typeof body.hint === 'string' && body.hint) return body.hint
  if (typeof body.message === 'string' && body.message) return body.message
  if (typeof body.error === 'string' && body.error) return body.error
  return null
}
