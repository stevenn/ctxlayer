import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { bumpLastSeen } from '../db/queries/users'
import type { MeResponse, Role } from '@ctxlayer/shared'

export const meRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()

meRoute.use('*', requireUser)

meRoute.get('/', async (c) => {
  // requireUser's per-request lifecycle re-check already fetched (and
  // status-gated) the full row — read it instead of a second findById.
  const row = c.get('userRow')
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
