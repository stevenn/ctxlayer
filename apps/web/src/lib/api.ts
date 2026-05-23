import { MeResponse, HealthResponse, ConfigResponse } from '@ctxlayer/shared'
import type {
  MeResponse as MeResponseT,
  HealthResponse as HealthResponseT,
  ConfigResponse as ConfigResponseT
} from '@ctxlayer/shared'

/** HTTP-level failure (non-2xx). */
export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`api ${status}`)
  }
}

/** Server returned 2xx but the body didn't match the expected schema. */
export class ApiSchemaError extends Error {
  constructor(public path: string, cause: unknown) {
    super(`api schema mismatch at ${path}`, { cause })
  }
}

async function get<T>(
  path: string,
  parse: (raw: unknown) => T,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(path, { credentials: 'include', ...init })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body)
  try {
    return parse(body)
  } catch (cause) {
    throw new ApiSchemaError(path, cause)
  }
}

export function fetchMe(signal?: AbortSignal): Promise<MeResponseT> {
  return get('/api/me', (b) => MeResponse.parse(b), { signal })
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponseT> {
  return get('/api/health', (b) => HealthResponse.parse(b), { signal })
}

export function fetchConfig(signal?: AbortSignal): Promise<ConfigResponseT> {
  return get('/api/config', (b) => ConfigResponse.parse(b), { signal })
}
