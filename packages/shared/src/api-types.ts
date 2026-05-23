import { z } from 'zod'

export const Role = z.enum(['user', 'admin'])
export type Role = z.infer<typeof Role>

export const Idp = z.enum(['google', 'github'])
export type Idp = z.infer<typeof Idp>

export const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  builtAt: z.string(),
  dependencies: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      latencyMs: z.number().optional(),
      error: z.string().optional()
    })
  )
})
export type HealthResponse = z.infer<typeof HealthResponse>

export const MeResponse = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  role: Role,
  idp: Idp,
  lastSeenAt: z.number().nullable()
})
export type MeResponse = z.infer<typeof MeResponse>

export const VersionResponse = z.object({
  gitSha: z.string(),
  builtAt: z.string()
})
export type VersionResponse = z.infer<typeof VersionResponse>
