/**
 * Static (pre-registered) OAuth flow for git sources — the friendly
 * alternative to paste-a-PAT. Reuses the generic static-OAuth helpers
 * (`upstream/oauth-static.ts`: buildAuthorizeRedirect / exchangeCode /
 * refreshStatic) by implementing their `StaticFlowProvider` contract against
 * the git tables instead of the upstream ones.
 *
 * Storage:
 *   - Client config (clientId / authorize+token URLs / scopes / sealed secret)
 *     lives in `git_sources.auth_config.oauth` (admin-configured, migration
 *     0022). DCR is not used — see 0022 / J-git.md.
 *   - PKCE verifier + flow context lives in `OAUTH_KV` under
 *     `git:verifier:<state>` (10-min TTL).
 *   - Tokens (access + refresh + expires_at) are sealed via crypto/aead and
 *     stored in `git_user_credentials` with kind='oauth'.
 *
 * Security: token-endpoint bodies are never logged (the static helpers log a
 * status + error code only).
 */

import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { UpstreamAuthConfig } from '@ctxlayer/shared'
import type { Env } from '../env'
import {
  getGitUserCredential,
  upsertGitUserCredential,
  type GitSourceRow
} from '../db/queries/git-sources'
import { staticOAuth, type StaticFlowProvider, type StaticOAuth } from '../upstream/oauth-static'
import { openStoredTokens, prepareStoredTokens } from '../upstream/oauth-tokens'

const VERIFIER_TTL_SECONDS = 600
const REDIRECT_PATH = '/api/git-sources/oauth/callback'

/** Where to bounce the user after the callback completes (validated targets). */
export interface GitOAuthReturn {
  docId?: string
  admin?: boolean
}

interface StoredGitVerifier {
  verifier: string
  userId: string
  gitSourceId: string
  return?: GitOAuthReturn
  createdAt: number
}

/** Parse a git source's auth_config JSON (NULL / malformed ⇒ empty). */
export function parseGitAuthConfig(json: string | null): UpstreamAuthConfig {
  if (!json) return {}
  try {
    return JSON.parse(json) as UpstreamAuthConfig
  } catch {
    return {}
  }
}

/** The source's static-OAuth config, or null when OAuth isn't configured. */
export function gitStaticOAuth(source: GitSourceRow): StaticOAuth | null {
  return staticOAuth(parseGitAuthConfig(source.auth_config))
}

export class GitOAuthFlowProvider implements StaticFlowProvider {
  private stateToken: string | null = null

  constructor(
    private readonly env: Env,
    private readonly source: GitSourceRow,
    private readonly userId: string,
    /** On the callback path, the `?state=` value; on start leave undefined. */
    presetState?: string,
    private readonly returnCtx?: GitOAuthReturn
  ) {
    if (presetState) this.stateToken = presetState
  }

  get redirectUrl(): string {
    return new URL(REDIRECT_PATH, this.env.PUBLIC_BASE_URL).toString()
  }

  state(): string {
    if (!this.stateToken) this.stateToken = crypto.randomUUID()
    return this.stateToken
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    const stored: StoredGitVerifier = {
      verifier,
      userId: this.userId,
      gitSourceId: this.source.id,
      return: this.returnCtx,
      createdAt: Math.floor(Date.now() / 1000)
    }
    await this.env.OAUTH_KV.put(verifierKey(this.state()), JSON.stringify(stored), {
      expirationTtl: VERIFIER_TTL_SECONDS
    })
  }

  async codeVerifier(): Promise<string> {
    const raw = await this.env.OAUTH_KV.get(verifierKey(this.state()))
    if (!raw) throw new Error('git_oauth_verifier_missing_or_expired')
    return (JSON.parse(raw) as StoredGitVerifier).verifier
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const cred = await getGitUserCredential(this.env, this.userId, this.source.id)
    if (!cred || cred.kind !== 'oauth') return undefined
    return openStoredTokens(
      this.env,
      { ciphertext: cred.ciphertext, iv: cred.iv, keyVersion: cred.key_version },
      `git oauth tokens decrypt failed for ${this.source.slug}`
    )
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // prepareStoredTokens carries the prior refresh_token + scope forward
    // when a refresh omits them (same rotation-safety as the upstream
    // provider).
    const { sealed } = await prepareStoredTokens(this.env, tokens, () => this.tokens())
    await upsertGitUserCredential(this.env, this.userId, this.source.id, {
      kind: 'oauth',
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      keyVersion: sealed.keyVersion
    })
  }
}

export async function readGitVerifierState(
  env: Env,
  state: string
): Promise<StoredGitVerifier | null> {
  const raw = await env.OAUTH_KV.get(verifierKey(state))
  return raw ? (JSON.parse(raw) as StoredGitVerifier) : null
}

export async function deleteGitVerifierState(env: Env, state: string): Promise<void> {
  await env.OAUTH_KV.delete(verifierKey(state))
}

function verifierKey(state: string): string {
  return `git:verifier:${state}`
}
