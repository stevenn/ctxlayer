/**
 * D1 queries for `git_connections` — the auth/identity holder a git REPO
 * (`git_sources` row) hangs under. A connection owns the provider/base_url,
 * the default credential strategies, the static-OAuth client config, and (via
 * connection_id) the shared token + per-user tokens + visibility grants. Many
 * repos can share one connection (configure auth once). See migration 0030 +
 * [[project-git-connection-repo-split]].
 *
 * Route handlers stay SQL-free; this module is sibling to git-sources.ts and
 * must NOT import it (no cycles).
 */

import type { Env } from '../../env'
import type { GitCredStrategy, GitProvider } from '@ctxlayer/shared'

export interface GitConnectionRow {
  id: string
  slug: string
  display_name: string
  provider: GitProvider
  base_url: string | null
  read_strategy: GitCredStrategy
  write_strategy: GitCredStrategy
  // Static-OAuth client config JSON ({ oauth: {...} }), or NULL for PAT-only.
  auth_config: string | null
  created_by: string | null
  created_at: number
  updated_at: number
}

const SELECT_CONN = `SELECT id, slug, display_name, provider, base_url, read_strategy,
  write_strategy, auth_config, created_by, created_at, updated_at
  FROM git_connections`

export async function getGitConnectionById(env: Env, id: string): Promise<GitConnectionRow | null> {
  return (
    (await env.DB.prepare(`${SELECT_CONN} WHERE id = ?1`).bind(id).first<GitConnectionRow>()) ?? null
  )
}

/** The connection that owns a repo (git_sources row), resolved by source id. */
export async function getGitConnectionForSource(
  env: Env,
  sourceId: string
): Promise<GitConnectionRow | null> {
  return (
    (await env.DB.prepare(
      `${SELECT_CONN} WHERE id = (SELECT connection_id FROM git_sources WHERE id = ?1)`
    )
      .bind(sourceId)
      .first<GitConnectionRow>()) ?? null
  )
}

export async function listGitConnections(env: Env): Promise<GitConnectionRow[]> {
  const res = await env.DB.prepare(`${SELECT_CONN} ORDER BY display_name`).all<GitConnectionRow>()
  return res.results ?? []
}

/** Set (or clear, with null) the static-OAuth client config JSON on a connection. */
export async function setGitConnectionAuthConfig(
  env: Env,
  connectionId: string,
  json: string | null
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(`UPDATE git_connections SET auth_config = ?2, updated_at = ?3 WHERE id = ?1`)
    .bind(connectionId, json, now)
    .run()
}
