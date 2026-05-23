/**
 * Signed-in user directory lookup. Powers the Sharing dialog's
 * autocomplete: type a few characters of someone's email, get back
 * up to 10 matches. Scoped to signed-in users (no admin requirement)
 * because doc sharing is a normal-user operation.
 *
 * Match shape: case-insensitive prefix on `email`. The lookup is
 * intentionally limited to email prefix — a fuzzier match across name
 * + email is doable but risks surprising hits when the user thinks
 * they're searching by exact address.
 */

import { Hono } from 'hono'
import type { UserSearchResult } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'

const MAX_RESULTS = 10
const MIN_PREFIX = 2

export const usersRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()

usersRoute.use('*', requireUser)
usersRoute.use('*', requireCsrf)

usersRoute.get('/', async (c) => {
  const emailPrefix = (c.req.query('email') ?? '').trim().toLowerCase()
  if (emailPrefix.length < MIN_PREFIX) return c.json([] satisfies UserSearchResult)
  const like = `${escapeLike(emailPrefix)}%`
  const res = await c.env.DB.prepare(
    `SELECT id, email, name FROM users
     WHERE LOWER(email) LIKE ?1 ESCAPE '\\'
     ORDER BY email
     LIMIT ?2`
  )
    .bind(like, MAX_RESULTS)
    .all<{ id: string; email: string; name: string | null }>()
  const body: UserSearchResult = res.results ?? []
  return c.json(body)
})

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
