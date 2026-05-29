import { z } from 'zod'

/**
 * One user-grant attribution for a registered OAuth client. Built by
 * fanning OAuthHelpers.listUserGrants() over every ctxlayer user and
 * grouping the results by `clientId`. `grantedAt` is the earliest
 * grant timestamp per (client, user) pair — earliest because re-auth
 * via OAuth refresh typically creates new grant rows but the
 * original authorisation moment is what the admin cares about.
 */
export const OAuthClientUserRef = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  grantedAt: z.number().int()
})
export type OAuthClientUserRef = z.infer<typeof OAuthClientUserRef>

/**
 * Read-only view of a registered OAuth client (DCR-registered by an
 * MCP client, or manually created via `OAuthHelpers.createClient`).
 * The viewer at /app/admin/oauth-clients consumes this shape.
 *
 * `clientSecret` is intentionally never exposed — only the *hash* is
 * stored in KV anyway, but we strip it server-side defensively.
 * `tokenEndpointAuthMethod === 'none'` means a public client (SPA /
 * mobile / MCP web app), anything else is confidential.
 *
 * `users` is the list of ctxlayer users who have authorised this
 * client (one entry per (client, user) pair). Empty array when no
 * one has granted access yet. Optional + defaults to [] so older
 * clients can still parse responses from a worker that hasn't been
 * updated.
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
  contacts: z.array(z.string()).nullable(),
  users: z.array(OAuthClientUserRef).default([])
})
export type OAuthClientRow = z.infer<typeof OAuthClientRow>

export const OAuthClientsResponse = z.object({
  clients: z.array(OAuthClientRow),
  // Forward cursor; null when we've reached the tail. Pass back via
  // `?cursor=<value>`.
  nextCursor: z.string().nullable()
})
export type OAuthClientsResponse = z.infer<typeof OAuthClientsResponse>
