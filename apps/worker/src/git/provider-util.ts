/**
 * Shared helpers for the raw-fetch git providers (github / gitlab / azure).
 * Pure, no I/O — URL/path encoding, prefix filtering, and base64 codec used
 * identically by every provider impl.
 */

/** Markdown file extensions we mirror. */
export const MD_RE = /\.(md|mdown|markdown|mkd)$/i

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
