import { ConfigResponse, MeResponse, VersionResponse } from '@ctxlayer/shared'
import { readCsrfToken } from '../csrf'

/** HTTP-level failure (non-2xx). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown
  ) {
    super(`api ${status}`)
  }
}

/** Server returned 2xx but the body didn't match the expected schema. */
export class ApiSchemaError extends Error {
  constructor(
    public path: string,
    cause: unknown
  ) {
    super(`api schema mismatch at ${path}`, { cause })
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Single fetch entry-point. Adds `credentials:'include'` so cookies
 * ride along, attaches `X-CSRF` on unsafe methods (cookie value echoed
 * — see apps/worker/src/auth/csrf.ts), and routes the response through
 * the caller's schema parser.
 */
export async function request<T>(
  path: string,
  parse: (raw: unknown) => T,
  init: RequestInit & { method?: string } = {}
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (!SAFE_METHODS.has(method)) {
    const token = readCsrfToken()
    if (token) headers.set('X-CSRF', token)
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
  }
  const res = await fetch(path, { credentials: 'include', ...init, method, headers })
  // 204 No Content shortcut — the parser is called with `undefined`
  // and most callers pass `() => undefined` to satisfy void.
  if (res.status === 204) {
    try {
      return parse(undefined)
    } catch (cause) {
      throw new ApiSchemaError(path, cause)
    }
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body)
  try {
    return parse(body)
  } catch (cause) {
    throw new ApiSchemaError(path, cause)
  }
}

// ----- session-shaped reads ----------------------------------------------

export function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  return request('/api/me', (b) => MeResponse.parse(b), { signal })
}

export function fetchConfig(signal?: AbortSignal): Promise<ConfigResponse> {
  return request('/api/config', (b) => ConfigResponse.parse(b), { signal })
}

// Build provenance for the footer version stamp. `gitSha`/`builtAt` are
// injected at deploy time by scripts/deploy.mjs (empty in local dev).
export function fetchVersion(signal?: AbortSignal): Promise<VersionResponse> {
  return request('/api/version', (b) => VersionResponse.parse(b), { signal })
}

export function signOut(): Promise<void> {
  return request('/api/auth/signout', () => undefined, { method: 'POST' })
}
