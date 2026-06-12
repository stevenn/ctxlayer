import { ApiError, ApiSchemaError } from './api'

type StatusOverride = string | ((err: ApiError) => string | null | undefined)

/**
 * Map any thrown value to a user-facing message. Handles the cases every
 * screen shares — 401 session-expiry, generic ApiError, schema mismatch,
 * plain Error, and network failure. Pass `overrides` keyed by HTTP status for
 * screen-specific copy, e.g. `explain(err, { 409: 'That slug is taken.' })`.
 * An override returning a falsy value falls through to the shared handling.
 */
export function explain(err: unknown, overrides: Record<number, StatusOverride> = {}): string {
  if (err instanceof ApiError) {
    const ov = overrides[err.status]
    if (ov !== undefined) {
      const msg = typeof ov === 'function' ? ov(err) : ov
      if (msg) return msg
    }
    if (err.status === 401) return 'Your session expired. Refresh to sign in again.'
    return `Server returned HTTP ${err.status}.`
  }
  if (err instanceof ApiSchemaError) return 'Server returned an unexpected response shape.'
  if (err instanceof Error) return err.message
  return 'Could not reach the server.'
}
