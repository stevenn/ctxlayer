import { bodyMessage, explain as explainBase } from '../../lib/explain'

export function explain(err: unknown): string {
  return explainBase(err, {
    403: "You don't have permission to change this skill.",
    404: 'Not found.',
    409: 'Slug already taken — pick another.',
    400: (e) => bodyMessage(e) ?? 'Server rejected the request.'
  })
}

// Preferred body-message order for this screen: hint → message → error.
