/**
 * D1 queries for doc_editors (per-doc ACL). Reads return the joined
 * shape the API surfaces — userId + email/name — so handlers don't
 * have to fan out to /api/users for every Sharing dialog open.
 */

import type { Env } from '../../env'

export interface DocEditorUserRow {
  user_id: string
  email: string
  name: string | null
  granted_by: string | null
  created_at: number
}

export interface DocEditorsView {
  users: DocEditorUserRow[]
  everyone: boolean
}

/**
 * Single-query read: join doc_editors→users for 'user' scope rows and
 * detect the 'everyone' row in the same pass. Returns a UI-shaped
 * object so the route does not transform.
 */
export async function listEditors(env: Env, docId: string): Promise<DocEditorsView> {
  const userRowsRes = await env.DB.prepare(
    `SELECT u.id AS user_id, u.email, u.name, e.granted_by, e.created_at
     FROM doc_editors e
     JOIN users u ON u.id = e.scope_id
     WHERE e.doc_id = ?1 AND e.scope_kind = 'user'
     ORDER BY e.created_at ASC`
  )
    .bind(docId)
    .all<DocEditorUserRow>()

  const everyoneRow = await env.DB.prepare(
    `SELECT 1 AS hit FROM doc_editors
     WHERE doc_id = ?1 AND scope_kind = 'everyone' AND scope_id = ''`
  )
    .bind(docId)
    .first<{ hit: number }>()

  return {
    users: userRowsRes.results ?? [],
    everyone: !!everyoneRow
  }
}

export async function addUserEditor(
  env: Env,
  docId: string,
  userId: string,
  grantedBy: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  // ON CONFLICT keeps the original granter and timestamp; a re-grant is
  // a no-op, not an audit-worthy event.
  await env.DB.prepare(
    `INSERT INTO doc_editors (doc_id, scope_kind, scope_id, granted_by, created_at)
     VALUES (?1, 'user', ?2, ?3, ?4)
     ON CONFLICT (doc_id, scope_kind, scope_id) DO NOTHING`
  )
    .bind(docId, userId, grantedBy, now)
    .run()
}

export async function addEveryoneEditor(env: Env, docId: string, grantedBy: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO doc_editors (doc_id, scope_kind, scope_id, granted_by, created_at)
     VALUES (?1, 'everyone', '', ?2, ?3)
     ON CONFLICT (doc_id, scope_kind, scope_id) DO NOTHING`
  )
    .bind(docId, grantedBy, now)
    .run()
}

export async function removeUserEditor(env: Env, docId: string, userId: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM doc_editors WHERE doc_id = ?1 AND scope_kind = 'user' AND scope_id = ?2`
  )
    .bind(docId, userId)
    .run()
}

export async function removeEveryoneEditor(env: Env, docId: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM doc_editors WHERE doc_id = ?1 AND scope_kind = 'everyone' AND scope_id = ''`
  )
    .bind(docId)
    .run()
}
