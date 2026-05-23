import { z } from 'zod'

export const UpstreamTransport = z.enum(['streamable_http', 'sse', 'stdio_daytona'])
export type UpstreamTransport = z.infer<typeof UpstreamTransport>

export const UpstreamConnected = z.object({
  slug: z.string(),
  displayName: z.string(),
  transport: UpstreamTransport,
  connected: z.boolean(),
  toolsCount: z.number().optional(),
  lastCalledAt: z.number().nullable().optional(),
  requiresAuth: z.string().optional(),
  connectUrl: z.string().url().optional(),
  sandboxState: z.enum(['starting', 'running', 'idle', 'archived', 'destroyed']).optional()
})
export type UpstreamConnected = z.infer<typeof UpstreamConnected>

export const ListUpstreamsResult = z.array(UpstreamConnected)
export type ListUpstreamsResult = z.infer<typeof ListUpstreamsResult>
