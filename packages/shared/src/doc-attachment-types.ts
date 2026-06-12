import { z } from 'zod'

// Symmetric with SkillAttachmentRef — one upstream-tool reference
// attached to a doc. Same semantics: tool_name empty = whole upstream.
export const DocAttachmentRef = z.object({
  upstreamId: z.string(),
  upstreamSlug: z.string(),
  toolName: z.string()
})
export type DocAttachmentRef = z.infer<typeof DocAttachmentRef>

export const AttachDocRequest = z.object({
  docId: z.string().min(1),
  upstreamId: z.string().min(1),
  toolName: z.string().optional()
})
export type AttachDocRequest = z.infer<typeof AttachDocRequest>
