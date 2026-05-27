import { randomBytes, createHash } from 'node:crypto'

/**
 * RFC 7636 PKCE: code_verifier is a high-entropy random string;
 * code_challenge is base64url(sha256(verifier)). Use 32 bytes
 * (matches the upper bound of the RFC's recommendation).
 */
export interface PkcePair {
  verifier: string
  challenge: string
}

export function newPkce(): PkcePair {
  const verifier = base64UrlEncode(randomBytes(32))
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function newState(): string {
  return base64UrlEncode(randomBytes(16))
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
