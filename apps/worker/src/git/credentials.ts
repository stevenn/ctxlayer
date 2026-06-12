/**
 * Resolve the access token for a git source. Reads use `read_strategy`
 * (shared org PAT, or the acting user's PAT/OAuth for interactive sync);
 * writes use `write_strategy` for authorship and fall back to the shared
 * token (bot author) so a PR still opens when the user hasn't connected.
 *
 * Tokens are sealed with AES-GCM in D1 (crypto/aead.ts). user_oauth rows
 * store a JSON token bundle; user_bearer / shared store the raw token.
 */

import type { Env } from '../env'
import { open } from '../crypto/aead'
import {
  getGitSharedCredential,
  getGitUserCredential,
  type GitSourceRow
} from '../db/queries/git-sources'
import { GitOAuthFlowProvider, gitStaticOAuth } from './git-oauth'
import { refreshStatic } from '../upstream/oauth-static'

interface SealedRow {
  ciphertext: Uint8Array
  iv: Uint8Array
  key_version: number
}

async function openToken(env: Env, row: SealedRow, kind: 'bearer' | 'oauth'): Promise<string> {
  const plaintext = await open(
    { ciphertext: row.ciphertext, iv: row.iv, keyVersion: row.key_version },
    env.ENCRYPTION_KEY
  )
  if (kind === 'oauth') {
    try {
      const j = JSON.parse(plaintext) as { access_token?: unknown }
      return typeof j.access_token === 'string' ? j.access_token : ''
    } catch {
      return ''
    }
  }
  return plaintext
}

/**
 * Resolve the acting user's token for a source: a freshly-refreshed OAuth
 * access token (static flow, 5-min expiry buffer) when the stored cred is
 * `oauth` AND the source has OAuth configured, else the stored bearer/oauth
 * token as-is. Null when there's no usable credential.
 */
async function resolveGitUserToken(
  env: Env,
  source: GitSourceRow,
  userId: string
): Promise<string | null> {
  const c = await getGitUserCredential(env, userId, source.id)
  if (!c) return null
  if (c.kind === 'oauth') {
    const oauth = gitStaticOAuth(source)
    if (oauth) {
      // Refresh near expiry + persist the rotated token.
      return refreshStatic(env, new GitOAuthFlowProvider(env, source, userId), oauth)
    }
    // Legacy: an oauth bundle is stored but no client config to refresh with.
    return openToken(env, c, 'oauth')
  }
  return openToken(env, c, 'bearer')
}

/**
 * Token for read/sync/index. shared_bearer ⇒ the org token; user_* ⇒ the
 * acting user's token (only available during interactive sync). Returns
 * null when no usable credential is configured.
 */
export async function resolveGitReadToken(
  env: Env,
  source: GitSourceRow,
  opts: { userId?: string }
): Promise<string | null> {
  if (source.read_strategy === 'shared_bearer') {
    const c = await getGitSharedCredential(env, source.id)
    return c ? openToken(env, c, 'bearer') : null
  }
  if (!opts.userId) return null
  return resolveGitUserToken(env, source, opts.userId)
}

export interface ResolvedWriteToken {
  token: string
  author: 'user' | 'shared'
}

/**
 * Token for write-back. Prefers the acting user's credential (correct
 * authorship) per `write_strategy`, then falls back to the shared org
 * token (commits authored as the bot). Null when neither exists.
 */
export async function resolveGitWriteToken(
  env: Env,
  source: GitSourceRow,
  userId: string
): Promise<ResolvedWriteToken | null> {
  if (source.write_strategy !== 'shared_bearer') {
    const token = await resolveGitUserToken(env, source, userId)
    if (token) return { token, author: 'user' }
  }
  const s = await getGitSharedCredential(env, source.id)
  if (s) {
    const token = await openToken(env, s, 'bearer')
    if (token) return { token, author: 'shared' }
  }
  return null
}
