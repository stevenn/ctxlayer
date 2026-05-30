import { z } from 'zod'

// Both transports are remote HTTP. A stdio MCP server is supported by running
// an operator-managed stdio<->HTTP bridge and registering it as a
// `streamable_http` upstream pointing at that bridge.
export const UpstreamTransport = z.enum(['streamable_http', 'sse'])
export type UpstreamTransport = z.infer<typeof UpstreamTransport>

export const UpstreamConnected = z.object({
  slug: z.string(),
  displayName: z.string(),
  transport: UpstreamTransport,
  connected: z.boolean(),
  toolsCount: z.number().optional(),
  lastCalledAt: z.number().nullable().optional(),
  requiresAuth: z.string().optional(),
  connectUrl: z.string().url().optional()
})
export type UpstreamConnected = z.infer<typeof UpstreamConnected>

export const ListUpstreamsResult = z.array(UpstreamConnected)
export type ListUpstreamsResult = z.infer<typeof ListUpstreamsResult>
