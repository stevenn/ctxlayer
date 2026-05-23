import { MeResponse, HealthResponse } from '@ctxlayer/shared'

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`api ${status}`)
  }
}

async function get<T>(path: string, parse: (raw: unknown) => T): Promise<T> {
  const res = await fetch(path, { credentials: 'include' })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body)
  return parse(body)
}

export function fetchMe(): Promise<import('@ctxlayer/shared').MeResponse> {
  return get('/api/me', (b) => MeResponse.parse(b))
}

export function fetchHealth(): Promise<import('@ctxlayer/shared').HealthResponse> {
  return get('/api/health', (b) => HealthResponse.parse(b))
}
