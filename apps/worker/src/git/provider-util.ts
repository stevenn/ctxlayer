/**
 * Shared helpers for the raw-fetch git providers (github / gitlab / azure):
 * URL/path encoding, prefix filtering, base64 codec, and the one HTTP
 * `providerCall` used by every provider impl.
 */

import { assertSafeFetchUrl } from '../util/safe-fetch'

/** Markdown file extensions we mirror. */
export const MD_RE = /\.(md|mdown|markdown|mkd)$/i

export interface CallResult {
  status: number
  json: unknown
}

export interface ProviderCallInput {
  /** Log prefix + error-code prefix (`<provider>_api_error:<status>`). */
  provider: string
  method: string
  /** Fully built URL — the caller appends provider quirks (e.g. ADO's
   * api-version query suffix) before handing it over. */
  url: string
  headers: HeadersInit
  body?: unknown
  /** Non-2xx statuses to return instead of throw (e.g. 404 probes). */
  allow?: number[]
  /** Extra non-secret detail appended to the error log line (e.g. the
   * provider's `message` field, github's SSO/permission hint headers).
   * MUST only surface known-safe fields — never the body wholesale. */
  errorDetail?: (json: unknown, res: Response) => string
}

/**
 * fetch + JSON-parse-or-null + allow-listed statuses. On a non-allowed
 * failure, logs `provider: METHOD url -> status` (+ errorDetail) — never
 * the response body, which can carry tokens or internal detail — and
 * throws the generic `<provider>_api_error:<status>` code.
 */
export async function providerCall(input: ProviderCallInput): Promise<CallResult> {
  assertSafeFetchUrl(input.url)
  const init: RequestInit = { method: input.method, headers: input.headers }
  if (input.body !== undefined) init.body = JSON.stringify(input.body)
  const res = await fetch(input.url, init)
  const text = await res.text()
  let json: unknown = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  if (!res.ok && !(input.allow ?? []).includes(res.status)) {
    const detail = input.errorDetail ? input.errorDetail(json, res) : ''
    console.error(`${input.provider}: ${input.method} ${input.url} -> ${res.status}${detail}`)
    throw new Error(`${input.provider}_api_error:${res.status}`)
  }
  return { status: res.status, json }
}

/** The provider's non-secret `message` field (gitlab also uses `error`). */
export function jsonMessage(json: unknown, fallbackKey?: 'error'): string {
  const body = json as { message?: unknown; error?: unknown } | null
  if (typeof body?.message === 'string') return body.message
  if (fallbackKey && typeof body?.[fallbackKey] === 'string') return body[fallbackKey] as string
  return ''
}

export function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

export function enc(s: string): string {
  return encodeURIComponent(s)
}

/** Encode a repo path, preserving '/' separators. */
export function encPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

export function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, '')
}

export function underPrefix(path: string, prefix: string): boolean {
  if (!prefix) return true
  return path === prefix || path.startsWith(`${prefix}/`)
}

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
