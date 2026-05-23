import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { bumpLastSeen, findById } from '../db/queries/users'
import type { MeResponse, Role } from '@ctxlayer/shared'

export const meRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()

meRoute.use('*', requireUser)

meRoute.get('/', async (c) => {
  const { userId } = c.get('user')
  const row = await findById(c.env, userId)
  if (!row) {
    // Cookie referenced a user that no longer exists (deleted in DB).
    // Caller should sign in again.
    return c.json({ error: 'not_signed_in' }, 401)
  }
  // Fire-and-forget last_seen update; tolerate transient D1 errors.
  c.executionCtx.waitUntil(
    bumpLastSeen(c.env, row.id).catch((err) => console.error('bumpLastSeen failed', err))
  )

  const body: MeResponse = {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role as Role,
    idp: row.idp,
    lastSeenAt: row.last_seen_at
  }
  return c.json(body)
})
