/**
 * Folder REST surface — derived from documents.folder paths. No
 * separate folders table; "create" happens implicitly when a doc lands
 * in a new path (handled by POST/PATCH /api/docs).
 *
 * - `GET    /api/folders` — flat list of every populated path with
 *   doc counts. SPA builds the tree client-side.
 * - `PATCH  /api/folders` — rename/move a folder (and everything
 *   nested). Only succeeds if the caller can edit *every* affected
 *   doc; otherwise 403 with the blocking ids surfaced.
 * - `DELETE /api/folders/:path` — succeeds only if the folder is
 *   empty (i.e. no doc has this path or a sub-path). For non-empty
 *   folders we return 409 with the count so the SPA can prompt
 *   "move/delete those docs first".
 *
 * Path values are passed in the URL for DELETE and in the body for
 * PATCH. DELETE accepts a base64url-encoded path (the leading "/"
 * makes a normal segment awkward) to keep the route un-ambiguous.
 */

import { Hono } from 'hono'
import {
  FolderPath,
  FolderRenameRequest,
  type FolderTreeResponse,
  type FolderTreeNode
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import {
  canEditDoc,
  listDocIdsInFolder,
  listFolderAggregates,
  renameFolderPrefix
} from '../db/queries/docs'
import { audit } from '../audit/log'

export const foldersRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
foldersRoute.use('*', requireUser)

foldersRoute.get('/', async (c) => {
  const rows = await listFolderAggregates(c.env)
  const body: FolderTreeResponse = {
    folders: rows.map(
      (r): FolderTreeNode => ({
        path: r.path,
        docCount: r.doc_count,
        descendantDocCount: r.descendant_doc_count
      })
    )
  }
  return c.json(body)
})

foldersRoute.patch('/', requireCsrf, async (c) => {
  const parsed = FolderRenameRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  }
  const { oldPath, newPath } = parsed.data
  if (oldPath === newPath) return c.json({ moved: 0, ids: [] })

  // Guard: callers can only rename a folder if they have edit
  // permission on every doc inside it. Surface the blocking ids so
  // the SPA can show "you can't edit these 3 docs" instead of just
  // 403.
  const { userId } = c.get('user')
  const affectedIds = await listDocIdsInFolder(c.env, oldPath)
  if (affectedIds.length === 0) {
    return c.json({ error: 'folder_empty_or_missing' }, 404)
  }
  const editChecks = await Promise.all(
    affectedIds.map((id) => canEditDoc(c.env, userId, id))
  )
  const blocking = affectedIds.filter((_, i) => !editChecks[i])
  if (blocking.length > 0) {
    return c.json(
      {
        error: 'forbidden',
        hint: `You can edit ${affectedIds.length - blocking.length}/${affectedIds.length} affected docs. Ask the editors of the rest to move them, or have an admin do it.`,
        blocking
      },
      403
    )
  }

  const movedIds = await renameFolderPrefix(c.env, oldPath, newPath)
  await audit(c.env, {
    actorId: userId,
    action: 'folder.rename',
    target: oldPath,
    meta: { oldPath, newPath, movedCount: movedIds.length }
  })
  return c.json({ moved: movedIds.length, ids: movedIds })
})

foldersRoute.delete('/:encodedPath', requireCsrf, async (c) => {
  const raw = c.req.param('encodedPath')
  let decoded: string
  try {
    // Accept base64url (with padding optional). Keeps slashes out of
    // the URL path segment so we don't have to worry about extra-slash
    // routing quirks.
    decoded = base64UrlDecode(raw)
  } catch {
    return c.json({ error: 'bad_path_encoding' }, 400)
  }
  const validated = FolderPath.safeParse(decoded)
  if (!validated.success) {
    return c.json({ error: 'bad_path_format', issues: validated.error.issues }, 400)
  }
  const path = validated.data
  const ids = await listDocIdsInFolder(c.env, path)
  if (ids.length > 0) {
    return c.json(
      {
        error: 'folder_not_empty',
        hint: `Move or delete the ${ids.length} doc${ids.length === 1 ? '' : 's'} in this folder first.`,
        docCount: ids.length
      },
      409
    )
  }
  // Empty folders don't physically exist in our storage model, so
  // there's nothing to do beyond returning success. Audit anyway so
  // the action shows up in the log.
  const { userId } = c.get('user')
  await audit(c.env, { actorId: userId, action: 'folder.delete', target: path })
  return new Response(null, { status: 204 })
})

function base64UrlDecode(s: string): string {
  const padded = s.padEnd(s.length + ((4 - (s.length % 4)) % 4), '=')
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  return atob(b64)
}
