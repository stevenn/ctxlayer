import { z } from 'zod'

/**
 * Read-only view of a registered OAuth client (DCR-registered by an
 * MCP client, or manually created via `OAuthHelpers.createClient`).
 * The viewer at /app/admin/oauth-clients consumes this shape.
 *
 * `clientSecret` is intentionally never exposed — only the *hash* is
 * stored in KV anyway, but we strip it server-side defensively.
 * `tokenEndpointAuthMethod === 'none'` means a public client (SPA /
 * mobile / MCP web app), anything else is confidential.
 */
export const OAuthClientRow = z.object({
  clientId: z.string(),
  clientName: z.string().nullable(),
  redirectUris: z.array(z.string()),
  registrationDate: z.number().int().nullable(),
  tokenEndpointAuthMethod: z.string(),
  grantTypes: z.array(z.string()).nullable(),
  responseTypes: z.array(z.string()).nullable(),
  clientUri: z.string().nullable(),
  logoUri: z.string().nullable(),
  policyUri: z.string().nullable(),
  tosUri: z.string().nullable(),
  contacts: z.array(z.string()).nullable()
})
export type OAuthClientRow = z.infer<typeof OAuthClientRow>

export const OAuthClientsResponse = z.object({
  clients: z.array(OAuthClientRow),
  // Forward cursor; null when we've reached the tail. Pass back via
  // `?cursor=<value>`.
  nextCursor: z.string().nullable()
})
export type OAuthClientsResponse = z.infer<typeof OAuthClientsResponse>
