/**
 * Admin CRUD for join codes (plan L admission). A join code is a shared
 * bearer secret an entity admin distributes; redeeming it admits per the
 * code's `on_redeem` (active | pending). Plaintext is returned exactly once
 * on creation; the store keeps only its hash. DELETE = revoke (keeps the row
 * for the audit). All routes gated by `requireAdmin` + router-wide CSRF.
 */

import { Hono } from 'hono'
import { CreateJoinCodeRequest, type CreateJoinCodeResponse } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { audit } from '../audit/log'
import { createJoinCode, listJoinCodes, revokeJoinCode } from '../db/queries/join-codes'
import { parseJsonBody } from './respond'

export const adminJoinCodesRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
adminJoinCodesRoute.use('*', requireAdmin)
adminJoinCodesRoute.use('*', requireCsrf)

adminJoinCodesRoute.get('/', async (c) => c.json(await listJoinCodes(c.env)))

adminJoinCodesRoute.post('/', async (c) => {
  const parsed = await parseJsonBody(c, CreateJoinCodeRequest)
  if (!parsed.ok) return parsed.res
  const { joinCode, code } = await createJoinCode(c.env, parsed.data, c.get('user').userId)
  await audit(c.env, {
    actorId: c.get('user').userId,
    action: 'join_code.create',
    target: joinCode.id,
    meta: {
      label: joinCode.label,
      domainRestrict: joinCode.domainRestrict,
      onRedeem: joinCode.onRedeem,
      maxUses: joinCode.maxUses,
      expiresAt: joinCode.expiresAt
    }
  })
  const body: CreateJoinCodeResponse = { joinCode, code }
  return c.json(body, 201)
})

// Revoke (the "delete" action). Idempotent.
adminJoinCodesRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await revokeJoinCode(c.env, id)
  await audit(c.env, { actorId: c.get('user').userId, action: 'join_code.revoke', target: id })
  return new Response(null, { status: 204 })
})
