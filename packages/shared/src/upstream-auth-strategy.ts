import { z } from 'zod'

export const AuthStrategy = z.enum(['none', 'shared_bearer', 'user_bearer', 'user_oauth'])
export type AuthStrategy = z.infer<typeof AuthStrategy>

const HttpAuthConfig = z.object({
  headerName: z.string().default('Authorization'),
  headerPrefix: z.string().default('Bearer ')
})

const OauthAuthConfig = z.object({
  authorizeUrl: z.string().url(),
  tokenUrl: z.string().url(),
  scopes: z.array(z.string()).default([]),
  clientId: z.string(),
  clientSecretCiphertext: z.string()
})

const StdioDaytonaConfig = z.object({
  snapshotId: z.string(),
  startCommand: z.string(),
  bridgePort: z.number().int().positive().default(8080),
  envTemplate: z.record(z.string(), z.string()).default({}),
  idleTimeoutSeconds: z.number().int().positive().default(600),
  perUser: z.literal(true).default(true),
  warmOnSessionStart: z.boolean().default(false)
})

export const UpstreamAuthConfig = z.object({
  http: HttpAuthConfig.optional(),
  oauth: OauthAuthConfig.optional(),
  stdio: StdioDaytonaConfig.optional()
})
export type UpstreamAuthConfig = z.infer<typeof UpstreamAuthConfig>
