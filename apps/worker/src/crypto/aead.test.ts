import { describe, expect, it } from 'vitest'
import { seal, open } from './aead'

// 32 random bytes, base64-encoded. Fixed value so the test is deterministic.
const KEY = 'JxQK0aw3pPRtKwhsoa3J9wQVcYAvkjbqcCpPjC4Sh7M='

describe('aead', () => {
  it('round-trips a plaintext', async () => {
    const sealed = await seal('hello world', KEY)
    expect(sealed.iv).toHaveLength(12)
    expect(sealed.keyVersion).toBe(1)
    expect(await open(sealed, KEY)).toBe('hello world')
  })

  it('emits distinct ciphertexts for identical plaintexts (random IV)', async () => {
    const a = await seal('x', KEY)
    const b = await seal('x', KEY)
    expect(a.iv).not.toEqual(b.iv)
    expect(a.ciphertext).not.toEqual(b.ciphertext)
  })

  it('fails to open with the wrong key', async () => {
    const sealed = await seal('secret', KEY)
    const wrong = 'AAAA' + KEY.slice(4)
    await expect(open(sealed, wrong)).rejects.toThrow()
  })

  it('rejects an ENCRYPTION_KEY that is not 32 bytes', async () => {
    await expect(seal('x', btoa('too short'))).rejects.toThrow(/32 bytes/)
  })

  it('rejects an unknown key_version on open', async () => {
    const sealed = await seal('x', KEY)
    await expect(open({ ...sealed, keyVersion: 7 }, KEY)).rejects.toThrow(/key_version/)
  })
})
