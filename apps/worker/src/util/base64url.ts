/**
 * The one base64url implementation (RFC 4648 §5, unpadded). Session
 * cookies, IdP state, CSRF tokens, PKCE, and Access-JWT parsing all
 * round-trip through this pair — keep it the only copy in the worker
 * so an alphabet or padding bug can't drift between security surfaces.
 */

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

/** Cryptographically random bytes as an unpadded base64url token. */
export function randomToken(byteLength = 32): string {
  const buf = new Uint8Array(byteLength)
  crypto.getRandomValues(buf)
  return b64urlEncode(buf)
}
