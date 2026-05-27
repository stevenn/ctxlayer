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

interface AuthedRequestOpts {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT'
  query?: Record<string, string | undefined>
  body?: unknown
}

/**
 * Auth-bearing fetch. Auto-refreshes on every call; on 401 the server
 * is asserting the bearer is invalid, so wipe creds and prompt
 * re-login. Returns parsed JSON; throws CtxlayerError with the
 * server's error code on non-2xx responses when possible.
 */
export async function authedRequest<T>(path: string, opts: AuthedRequestOpts = {}): Promise<T> {
  const initial = await loadCredentials()
  if (!initial) {
    throw new CtxlayerError(
      'Not logged in. Run `ctxlayer login --base-url <https://...>` first.',
      'not_logged_in'
    )
  }
  const creds = await refreshIfNeeded(initial)
  const url = new URL(`${creds.baseUrl}${path}`)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, v)
    }
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${creds.accessToken}`
  }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  })
  if (res.status === 401) {
    await deleteCredentials()
    throw new CtxlayerError(
      'Server rejected the access token. Run `ctxlayer login` to re-authenticate.',
      'auth_rejected'
    )
  }
  if (!res.ok) {
    // Try to extract a typed error code from the body. Server uses
    // { error: 'code', hint?, message? } convention.
    let serverMsg = ''
    try {
      const body = (await res.json()) as { error?: string; hint?: string; message?: string }
      if (body.hint) serverMsg = body.hint
      else if (body.message) serverMsg = body.message
      else if (body.error) serverMsg = body.error
    } catch {
      /* swallow */
    }
    throw new CtxlayerError(
      `Server returned HTTP ${res.status} on ${path}${serverMsg ? ` — ${serverMsg}` : ''}.`,
      'http_error'
    )
  }
  // 204 no-content
  if (res.status === 204) return undefined as unknown as T
  return (await res.json()) as T
}

/**
 * Convenience: bearer-authed GET. Wraps authedRequest for the common
 * read-only path the `pull` and `whoami` commands use.
 */
export async function authedGet<T>(path: string): Promise<T> {
  return await authedRequest<T>(path, { method: 'GET' })
}
