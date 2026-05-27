import { promises as fs } from 'node:fs'
import { z } from 'zod'
import { configDir, credentialsFile } from '../paths'

/**
 * Local credential bundle. Stored as JSON at the per-OS configDir().
 * Refresh tokens are long-lived; access tokens we keep alongside +
 * refresh on-demand when expiresAt approaches now.
 *
 * baseUrl is persisted so subsequent commands don't need --base-url.
 * clientId is the DCR-registered first-party CLI client.
 */
export const StoredCredentials = z.object({
  baseUrl: z.string().url(),
  clientId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().int().positive(),
  userId: z.string().optional(),
  userEmail: z.string().optional()
})
export type StoredCredentials = z.infer<typeof StoredCredentials>

export async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    const raw = await fs.readFile(credentialsFile(), 'utf-8')
    return StoredCredentials.parse(JSON.parse(raw))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    // Corrupt file → treat as no creds (caller will prompt re-login)
    return null
  }
}

export async function saveCredentials(creds: StoredCredentials): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true })
  const path = credentialsFile()
  await fs.writeFile(path, JSON.stringify(creds, null, 2) + '\n', 'utf-8')
  if (process.platform !== 'win32') {
    // 0o600. On Windows this is a no-op anyway — the file lives under
    // %APPDATA% which is already user-profile scoped.
    await fs.chmod(path, 0o600)
  }
}

export async function deleteCredentials(): Promise<void> {
  try {
    await fs.rm(credentialsFile(), { force: true })
  } catch {
    /* swallow */
  }
}
