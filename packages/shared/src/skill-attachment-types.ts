import { z } from 'zod'

// POST / DELETE body for /api/skill-attachments. tool_name optional;
// empty/missing means "attach to the whole upstream" (skill surfaces on
// the upstream's row, not a specific tool row).
export const AttachSkillRequest = z.object({
  skillId: z.string().min(1),
  upstreamId: z.string().min(1),
  toolName: z.string().optional()
})
export type AttachSkillRequest = z.infer<typeof AttachSkillRequest>

export const DetachSkillRequest = AttachSkillRequest
export type DetachSkillRequest = z.infer<typeof DetachSkillRequest>
