/**
 * Shared request/response atoms for the REST handlers under api/.
 * Captures the two patterns every router repeats: parse-and-400 on a
 * Zod-validated JSON body, and the standard `not_found` 404 body.
 * Handlers with bespoke 400/404 shapes keep their inline responses.
 */

import type { Context } from 'hono'
import type { z } from 'zod'

type ParseJsonBodyResult<S extends z.ZodTypeAny> =
  | { ok: true; data: z.output<S> }
  | { ok: false; res: Response }

/**
 * Read the request body as JSON (`null` on invalid/missing JSON) and
 * validate it with `schema`. On failure returns the canonical
 * `{ error: 'bad_request', issues }` 400 response for the caller to
 * return as-is.
 */
export async function parseJsonBody<S extends z.ZodTypeAny>(
  c: Context,
  schema: S
): Promise<ParseJsonBodyResult<S>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return { ok: false, res: c.json({ error: 'bad_request', issues: parsed.error.issues }, 400) }
  }
  return { ok: true, data: parsed.data }
}

/** The canonical `{ error: 'not_found' }` 404 response. */
export function notFound(c: Context): Response {
  return c.json({ error: 'not_found' }, 404)
}
