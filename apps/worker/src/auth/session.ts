/**
 * SPA session cookie. Strictly `__Host-` prefixed — the browser refuses
 * the cookie unless the response is Secure, has Path=/, and omits Domain,
 * which is the hardening we want. Dev runs over HTTPS via the mkcert
 * bootstrap in scripts/setup-dev-tls.mjs.
 *
 * Format: `<base64url(payload-json)>.<base64url(hmac)>`
 * Payload: { userId, role, iat, exp }   // seconds since epoch
 * HMAC: SHA-256 of the payload-json bytes, keyed by SESSION_COOKIE_SECRET.
 */

import type { Role } from '@ctxlayer/shared'

export const COOKIE_NAME = '__Host-ctx_session'
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export interface SessionPayload {
  userId: string
  role: Role
  iat: number
  exp: number
}

export async function signSession(
  payload: { userId: string; role: Role },
  secret: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<string> {
  const full: SessionPayload = {
    userId: payload.userId,
    role: payload.role,
    iat: now,
    exp: now + MAX_AGE_SECONDS
  }
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(full)))
  const sig = await hmacSign(body, secret)
  return `${body}.${sig}`
}

export async function verifySession(
  cookieValue: string | undefined,
  secret: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<SessionPayload | null> {
  if (!cookieValue) return null
  const dot = cookieValue.indexOf('.')
  if (dot <= 0) return null
  const body = cookieValue.slice(0, dot)
  const sig = cookieValue.slice(dot + 1)
  const ok = await hmacVerify(body, sig, secret)
  if (!ok) return null
  let payload: SessionPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)))
  } catch {
    return null
  }
  if (
    typeof payload.userId !== 'string' ||
    typeof payload.role !== 'string' ||
    typeof payload.exp !== 'number' ||
    payload.exp < now
  ) {
    return null
  }
  return payload
}

export function sessionSetCookie(value: string): string {
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}`
}

export function sessionClearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
}

/** Read the session cookie value off a Request's Cookie header. */
export function readSessionCookie(req: Request): string | undefined {
  return readCookie(req, COOKIE_NAME)
}

// ----- helpers (also reused by idp/common.ts via re-export) ---------------

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq) === name) return part.slice(eq + 1)
  }
  return undefined
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : ''
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

export async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return b64urlEncode(new Uint8Array(sig))
}

export async function hmacVerify(
  data: string,
  signatureB64Url: string,
  secret: string
): Promise<boolean> {
  const key = await importHmacKey(secret)
  let sigBytes: Uint8Array
  try {
    sigBytes = b64urlDecode(signatureB64Url)
  } catch {
    return false
  }
  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data))
}
