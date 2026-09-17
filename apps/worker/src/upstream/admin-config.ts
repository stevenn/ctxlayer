/**
 * Policy applied to admin-supplied upstream config before it persists —
 * timeout clamping, static-OAuth secret sealing, and the OAuth-endpoint
 * self-loop guard. Lives with the upstream domain (not the admin route
 * file) so the rules read next to the client/catalogue code they protect.
 */

import {
  isSameOrigin,
  isStaticOAuthConfig,
  type UpdateUpstreamRequest,
  type UpstreamAuthConfig
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { seal, sealedToString } from '../crypto/aead'
import { UPSTREAM_TIMEOUT_CLAMP_MS } from './http-client'

/**
 * Defensive clamp on per-upstream timeout overrides before they hit D1.
 * A 150-300s call blocks the serial McpSessionDO for that whole window
 * (docs/plan/I-upstream-resilience.md §I5.1), so no upstream may opt into
 * a window longer than the platform-safe hard cap. The client re-clamps
 * on read; this just keeps the persisted values honest for the admin UI.
 */
export function clampTimeouts(
  cfg: UpdateUpstreamRequest['authConfig']
): UpdateUpstreamRequest['authConfig'] {
  if (!cfg?.timeouts) return cfg
  const clamp = (v: number | undefined) =>
    v === undefined ? undefined : Math.min(v, UPSTREAM_TIMEOUT_CLAMP_MS)
  return {
    ...cfg,
    timeouts: {
      callMs: clamp(cfg.timeouts.callMs),
      maxCallMs: clamp(cfg.timeouts.maxCallMs),
      listMs: clamp(cfg.timeouts.listMs)
    }
  }
}

/**
 * Seal the write-only static-OAuth `clientSecret` from the admin form into
 * `clientSecretCiphertext`, and strip the plaintext so it never reaches D1.
 * On edit with no new secret, carry the existing sealed value forward —
 * PATCH replaces the whole auth_config column and the read path redacts the
 * ciphertext, so the form can't round-trip it. No-op when there's no oauth
 * block (every non-`user_oauth` upstream, and DCR clients).
 */
export async function prepareOAuthSecret(
  cfg: UpdateUpstreamRequest['authConfig'],
  env: Env,
  current: UpstreamAuthConfig | undefined
): Promise<UpdateUpstreamRequest['authConfig']> {
  if (!cfg?.oauth) return cfg
  const oauth = { ...cfg.oauth }
  if (oauth.clientSecret) {
    const sealed = await seal(oauth.clientSecret, env.ENCRYPTION_KEY)
    oauth.clientSecretCiphertext = sealedToString(sealed)
  } else if (current?.oauth?.clientSecretCiphertext) {
    oauth.clientSecretCiphertext = current.oauth.clientSecretCiphertext
  }
  oauth.clientSecret = undefined // never persist plaintext (dropped by JSON.stringify)
  return { ...cfg, oauth }
}

/**
 * Carry a DCR upstream's client registration across an admin edit.
 *
 * `oauth.client_info` (+ `client_id` / `client_secret`) is what ctxlayer got
 * back from the upstream's Dynamic Client Registration, and EVERY user's
 * stored refresh token is bound to that client_id. It is server-only: the
 * admin read path redacts it (`redactOAuthSecrets`), so the drawer can only
 * ever send the config back WITHOUT it — and PATCH replaces the whole
 * `auth_config` column. Unguarded, saving any field on a connected DCR
 * upstream (a timeout, the authorization lifetime) silently dropped the
 * registration; the next `auth()` run re-registered under a NEW client_id and
 * every user's refresh then failed as "issued to another client" — a mass
 * forced re-auth from an innocent edit. (Latent until 2026-09-17: every prod
 * edit so far happened before the first user connected.)
 *
 * Dropped on purpose only when the registration stops being valid: `keep` is
 * false when the strategy leaves `user_oauth` or the URL changes (a different
 * server/AS), and a switch to a pre-registered static client wins outright.
 */
export function preserveDcrClient(
  cfg: UpdateUpstreamRequest['authConfig'],
  current: UpstreamAuthConfig | undefined,
  keep: boolean
): UpdateUpstreamRequest['authConfig'] {
  const dcr = current?.oauth
  if (!cfg || !keep || !dcr?.client_info) return cfg
  if (isStaticOAuthConfig(cfg)) return cfg
  return {
    ...cfg,
    oauth: {
      ...(cfg.oauth ?? {}),
      client_id: dcr.client_id,
      client_secret: dcr.client_secret,
      client_info: dcr.client_info
    }
  }
}

/**
 * Self-loop guard for admin-supplied static-OAuth endpoints — same rule as
 * the upstream URL itself (and as `admin-git-sources.ts` applies to its
 * `tokenUrl`): the worker must never POST the authorization code + sealed
 * client secret back into its own origin.
 */
export function oauthEndpointSelfLoop(
  cfg: UpdateUpstreamRequest['authConfig'],
  env: Env
): boolean {
  const oauth = cfg?.oauth
  if (!oauth) return false
  return [oauth.authorizeUrl, oauth.tokenUrl].some(
    (u) => typeof u === 'string' && isSameOrigin(u, env.PUBLIC_BASE_URL)
  )
}
