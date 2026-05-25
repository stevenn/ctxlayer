/**
 * AES-GCM authenticated-encryption helpers for `user_credentials`.
 *
 * The on-disk layout is `{ ciphertext, iv, key_version }`:
 *   - ciphertext: AES-GCM output (includes auth tag in the trailing 16 bytes)
 *   - iv: random 12 bytes per seal call
 *   - key_version: which raw key to derive from `env.ENCRYPTION_KEY` (single
 *     version today; rotation extends `KEY_VERSIONS`).
 *
 * `ENCRYPTION_KEY` is a base64-encoded 32-byte secret. Keys are imported
 * lazily and cached per-isolate so subsequent seal/open calls skip
 * `crypto.subtle.importKey`.
 */
const IV_BYTES = 12
const KEY_BYTES = 32

// Cached per `(encryptionKey, keyVersion)` — production runs with one
// ENCRYPTION_KEY per isolate, but tests vary it across cases.
const keyCache = new Map<string, Promise<CryptoKey>>()

export interface SealedSecret {
  ciphertext: Uint8Array
  iv: Uint8Array
  keyVersion: number
}

export async function seal(plaintext: string, encryptionKey: string): Promise<SealedSecret> {
  const key = await getKey(encryptionKey, 1)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  )
  return { ciphertext, iv, keyVersion: 1 }
}

export async function open(sealed: SealedSecret, encryptionKey: string): Promise<string> {
  const key = await getKey(encryptionKey, sealed.keyVersion)
  // SubtleCrypto rejects views over a SharedArrayBuffer; .slice() also
  // detaches us from a possibly-larger backing buffer (D1 BLOBs come
  // back as Uint8Array views into the result row).
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.iv.slice() },
    key,
    sealed.ciphertext.slice()
  )
  return new TextDecoder().decode(plaintext)
}

async function getKey(encryptionKey: string, version: number): Promise<CryptoKey> {
  if (version !== 1) throw new Error(`unknown key_version: ${version}`)
  const cacheKey = `${version}:${encryptionKey}`
  let promise = keyCache.get(cacheKey)
  if (!promise) {
    promise = importKey(encryptionKey).catch((err) => {
      keyCache.delete(cacheKey)
      throw err
    })
    keyCache.set(cacheKey, promise)
  }
  return promise
}

async function importKey(encryptionKey: string): Promise<CryptoKey> {
  const raw = base64Decode(encryptionKey)
  if (raw.length !== KEY_BYTES) {
    throw new Error(`ENCRYPTION_KEY must be ${KEY_BYTES} bytes base64-encoded; got ${raw.length}`)
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
