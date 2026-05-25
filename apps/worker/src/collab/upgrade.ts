/**
 * `GET /collab/:docId` upgrade handler. Verifies the session cookie,
 * looks up the doc, decides read/write, and forwards the request to
 * the per-doc `DocRoomDO` instance.
 *
 * Cookie auth is the right shape here — WebSocket handshakes carry
 * `Cookie` automatically same-origin, but browsers refuse to set any
 * other header on `new WebSocket()`. So we cannot run the double-
 * submit CSRF check on the upgrade. The mitigation: cross-origin
 * websocket connects to same-origin URLs still get the cookie, so
 * we additionally require `Origin === PUBLIC_BASE_URL`. The
 * `DocRoomDO` itself never accepts state-changing HTTP frames, only
 * `wss://` messages tagged via the per-socket attachment.
 */

import type { Env } from '../env'
import { readSessionCookie, verifySession } from '../auth/session'
import { canEditDoc, getDocById } from '../db/queries/docs'
import { isAllowedOrigin } from '../util/origin'

export async function handleCollabUpgrade(
  req: Request,
  env: Env,
  docId: string | undefined
): Promise<Response> {
  if (req.headers.get('upgrade') !== 'websocket') {
    return new Response('expected websocket upgrade', { status: 426 })
  }
  if (!docId) return new Response('missing docId', { status: 400 })

  if (!isAllowedOrigin(req.headers.get('origin'), env.PUBLIC_BASE_URL)) {
    return new Response('bad_origin', { status: 403 })
  }

  const session = await verifySession(readSessionCookie(req), env.SESSION_COOKIE_SECRET)
  if (!session) return new Response('not_signed_in', { status: 401 })

  const doc = await getDocById(env, docId)
  if (!doc) return new Response('not_found', { status: 404 })

  const canEdit = await canEditDoc(env, session.userId, docId)

  // Forward to the per-doc DO. The DO reads `docId`, `x-ctx-user-id`,
  // and `x-ctx-can-edit` to attach per-socket metadata.
  const id = env.DOC_ROOM_DO.idFromName(docId)
  const stub = env.DOC_ROOM_DO.get(id)
  const fwd = new Request(`https://do/?docId=${encodeURIComponent(docId)}`, {
    method: 'GET',
    headers: {
      Upgrade: 'websocket',
      'x-ctx-user-id': session.userId,
      'x-ctx-can-edit': canEdit ? '1' : '0'
    }
  })
  return stub.fetch(fwd)
}
