import { z } from 'zod'

export const AuthStrategy = z.enum(['none', 'shared_bearer', 'user_bearer', 'user_oauth'])
export type AuthStrategy = z.infer<typeof AuthStrategy>

const HttpAuthConfig = z.object({
  headerName: z.string().default('Authorization'),
  headerPrefix: z.string().default('Bearer ')
})

// OAuth config supports two shapes that share the same JSON column:
//   - DCR (default): the worker registers via RFC 7591 against the upstream's
//     discovered authorization server and persists the response under
//     `client_info`. All other fields are optional.
//   - Pre-registered (future, admin-configured): supply `authorizeUrl` +
//     `tokenUrl` + `clientId` (+ optional sealed `clientSecretCiphertext`)
//     to skip discovery / DCR.
//
// `client_info` mirrors the SDK's `OAuthClientInformationFull` shape. Held
// here as a loose record so we don't pull SDK types into the shared package.
const OauthAuthConfig = z
  .object({
    authorizeUrl: z.string().url().optional(),
    tokenUrl: z.string().url().optional(),
    scopes: z.array(z.string()).optional(),
    clientId: z.string().optional(),
    clientSecretCiphertext: z.string().optional(),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    client_info: z.record(z.string(), z.unknown()).optional()
  })
  .passthrough()

export const UpstreamAuthConfig = z.object({
  http: HttpAuthConfig.optional(),
  oauth: OauthAuthConfig.optional()
})
export type UpstreamAuthConfig = z.infer<typeof UpstreamAuthConfig>
