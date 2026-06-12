import {
  AttachDocRequest,
  AttachSkillRequest,
  CreateSkillRequest,
  DocAttachmentRef,
  DocContent,
  RestoreRequest,
  SkillContentSaveResult,
  SkillDetail,
  SkillRevisionSummary,
  SkillSummary,
  UpdateSkillRequest
} from '@ctxlayer/shared'
import { z } from 'zod'
import { request } from './core'

// ----- skills (M7a) -------------------------------------------------------

const SkillList = z.array(SkillSummary)
const CreateSkillResult = z.object({ id: z.string(), slug: z.string() })
const RestoreResult = z.object({ revisionId: z.string() })
const SkillRevisionList = z.array(SkillRevisionSummary)
const DocAttachmentList = z.array(DocAttachmentRef)

export interface FetchSkillsOpts {
  status?: 'draft' | 'published' | 'archived' | 'all'
}

export function fetchSkills(
  opts: FetchSkillsOpts = {},
  signal?: AbortSignal
): Promise<SkillSummary[]> {
  const qs = opts.status ? `?status=${encodeURIComponent(opts.status)}` : ''
  return request(`/api/skills${qs}`, (b) => SkillList.parse(b), { signal })
}

export function fetchSkill(id: string, signal?: AbortSignal): Promise<SkillDetail> {
  return request(`/api/skills/${encodeURIComponent(id)}`, (b) => SkillDetail.parse(b), {
    signal
  })
}

export function createSkill(input: CreateSkillRequest): Promise<{ id: string; slug: string }> {
  return request('/api/skills', (b) => CreateSkillResult.parse(b), {
    method: 'POST',
    body: JSON.stringify(CreateSkillRequest.parse(input))
  })
}

export function patchSkill(id: string, patch: UpdateSkillRequest): Promise<void> {
  return request(`/api/skills/${encodeURIComponent(id)}`, () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateSkillRequest.parse(patch))
  })
}

export function deleteSkill(id: string): Promise<void> {
  return request(`/api/skills/${encodeURIComponent(id)}`, () => undefined, { method: 'DELETE' })
}

export function fetchSkillContent(id: string, signal?: AbortSignal): Promise<DocContent> {
  return request(`/api/skills/${encodeURIComponent(id)}/content`, (b) => DocContent.parse(b), {
    signal
  })
}

// See putDocContent: `explicit: false` opts a background autosave into
// coalescing (`?mode=autosave`); the default cuts a distinct revision.
export function putSkillContent(
  id: string,
  content: DocContent,
  opts: { explicit?: boolean; signal?: AbortSignal } = {}
): Promise<SkillContentSaveResult> {
  const qs = opts.explicit === false ? '?mode=autosave' : ''
  return request(
    `/api/skills/${encodeURIComponent(id)}/content${qs}`,
    (b) => SkillContentSaveResult.parse(b),
    {
      method: 'PUT',
      body: JSON.stringify(DocContent.parse(content)),
      signal: opts.signal
    }
  )
}

export function fetchSkillRevisions(
  id: string,
  signal?: AbortSignal
): Promise<SkillRevisionSummary[]> {
  return request(
    `/api/skills/${encodeURIComponent(id)}/revisions`,
    (b) => SkillRevisionList.parse(b),
    { signal }
  )
}

export function restoreSkillRevision(
  id: string,
  body: RestoreRequest
): Promise<{ revisionId: string }> {
  return request(`/api/skills/${encodeURIComponent(id)}/restore`, (b) => RestoreResult.parse(b), {
    method: 'POST',
    body: JSON.stringify(RestoreRequest.parse(body))
  })
}

export function fetchSkillRevisionContent(
  id: string,
  revisionId: string,
  signal?: AbortSignal
): Promise<DocContent> {
  return request(
    `/api/skills/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/content`,
    (b) => DocContent.parse(b),
    { signal }
  )
}

// ----- attachments (M7a) --------------------------------------------------

export function attachSkill(input: AttachSkillRequest): Promise<void> {
  return request('/api/skill-attachments', () => undefined, {
    method: 'POST',
    body: JSON.stringify(AttachSkillRequest.parse(input))
  })
}

export function detachSkill(input: AttachSkillRequest): Promise<void> {
  return request('/api/skill-attachments', () => undefined, {
    method: 'DELETE',
    body: JSON.stringify(AttachSkillRequest.parse(input))
  })
}

export function fetchDocAttachments(
  docId: string,
  signal?: AbortSignal
): Promise<DocAttachmentRef[]> {
  const qs = new URLSearchParams({ docId })
  return request(`/api/doc-attachments?${qs}`, (b) => DocAttachmentList.parse(b), {
    signal
  })
}

export function attachDoc(input: AttachDocRequest): Promise<void> {
  return request('/api/doc-attachments', () => undefined, {
    method: 'POST',
    body: JSON.stringify(AttachDocRequest.parse(input))
  })
}

export function detachDoc(input: AttachDocRequest): Promise<void> {
  return request('/api/doc-attachments', () => undefined, {
    method: 'DELETE',
    body: JSON.stringify(AttachDocRequest.parse(input))
  })
}
