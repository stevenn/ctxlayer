import { CtxlayerError } from '../errors'
import {
  deleteCredentials,
  loadCredentials,
  saveCredentials,
  type StoredCredentials
} from './token-store'

const REFRESH_BUFFER_SECONDS = 60

/**
 * Refresh the access token if it expires within REFRESH_BUFFER_SECONDS.
 * On refresh failure (e.g. revoked refresh token) the local credentials
 * are wiped and the caller is prompted to re-login.
 */
export async function refreshIfNeeded(creds: StoredCredentials): Promise<StoredCredentials> {
  const now = Math.floor(Date.now() / 1000)
  if (creds.expiresAt > now + REFRESH_BUFFER_SECONDS) return creds
  const res = await fetch(`${creds.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: creds.clientId
    })
  })
  if (!res.ok) {
    // Don't log the body — it can carry meta useful to leak. Just code.
    await deleteCredentials()
    throw new CtxlayerError(
      'Session expired. Run `ctxlayer login` to re-authenticate.',
      'auth_expired'
    )
  }
  const body = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }
  const updated: StoredCredentials = {
    ...creds,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? creds.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + body.expires_in
  }
  await saveCredentials(updated)
  return updated
}

/**
 * Auth-bearing GET. Auto-refreshes on every call; on 401 the server is
 * asserting the bearer is invalid, so wipe creds and prompt re-login.
 */
export async function authedGet<T>(path: string): Promise<T> {
  const initial = await loadCredentials()
  if (!initial) {
    throw new CtxlayerError(
      'Not logged in. Run `ctxlayer login --base-url <https://...>` first.',
      'not_logged_in'
    )
  }
  const creds = await refreshIfNeeded(initial)
  const res = await fetch(`${creds.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${creds.accessToken}` }
  })
  if (res.status === 401) {
    await deleteCredentials()
    throw new CtxlayerError(
      'Server rejected the access token. Run `ctxlayer login` to re-authenticate.',
      'auth_rejected'
    )
  }
  if (!res.ok) {
    throw new CtxlayerError(
      `Server returned HTTP ${res.status} on ${path}.`,
      'http_error'
    )
  }
  return (await res.json()) as T
}
