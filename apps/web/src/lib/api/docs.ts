import {
  AddEditorRequest,
  CreateDocRequest,
  DocContent,
  DocDetail,
  DocEditorsResponse,
  DocLinksResponse,
  DocSummary,
  DocTags,
  FolderRenameRequest,
  RestoreRequest,
  RevisionSummary,
  SearchRequest,
  SearchResponse,
  SetLockedRequest,
  TagVocab,
  UpdateDocRequest,
  UserSearchResult
} from '@ctxlayer/shared'
import { z } from 'zod'
import { request } from './core'

// ----- docs CRUD ----------------------------------------------------------

const DocList = z.array(DocSummary)
const CreateDocResult = z.object({ id: z.string(), slug: z.string() })
const PutContentResult = z.object({
  revisionId: z.string(),
  byteSize: z.number(),
  contentHash: z.string()
})
const RestoreResult = z.object({ revisionId: z.string() })
const RevisionList = z.array(RevisionSummary)

export function fetchDocs(signal?: AbortSignal): Promise<DocSummary[]> {
  return request('/api/docs', (b) => DocList.parse(b), { signal })
}

// Admin: rebuild the search index for every doc (after a chunking /
// embedding change). Returns how many reindex jobs were enqueued.
const ReindexResult = z.object({ queued: z.number(), total: z.number() })
export function adminReindexAllDocs(): Promise<{ queued: number; total: number }> {
  return request('/api/admin/docs/reindex', (b) => ReindexResult.parse(b), { method: 'POST' })
}

// Semantic RAG search over the doc library. POST so the query + scope
// ride in the body (and to match the worker's CSRF-gated route).
export function searchDocs(req: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
  return request('/api/search', (b) => SearchResponse.parse(b), {
    method: 'POST',
    body: JSON.stringify(SearchRequest.parse(req)),
    signal
  })
}

export function createDoc(input: CreateDocRequest): Promise<{ id: string; slug: string }> {
  return request('/api/docs', (b) => CreateDocResult.parse(b), {
    method: 'POST',
    body: JSON.stringify(CreateDocRequest.parse(input))
  })
}

export function fetchDoc(id: string, signal?: AbortSignal): Promise<DocDetail> {
  return request(`/api/docs/${encodeURIComponent(id)}`, (b) => DocDetail.parse(b), { signal })
}

export function patchDoc(id: string, patch: UpdateDocRequest): Promise<void> {
  return request(`/api/docs/${encodeURIComponent(id)}`, () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateDocRequest.parse(patch))
  })
}

export function deleteDoc(id: string): Promise<void> {
  return request(`/api/docs/${encodeURIComponent(id)}`, () => undefined, { method: 'DELETE' })
}

export function fetchDocContent(id: string, signal?: AbortSignal): Promise<DocContent> {
  return request(`/api/docs/${encodeURIComponent(id)}/content`, (b) => DocContent.parse(b), {
    signal
  })
}

// `explicit` distinguishes a user Save (cuts a distinct revision) from a
// background autosave (coalesces into the rolling autosave revision —
// `?mode=autosave`). Default is explicit so any caller that doesn't opt in
// (e.g. doc import) keeps the old "every save is a checkpoint" behaviour.
// `signal` lets callers attach a timeout (AbortSignal.timeout) so a hung
// request can't wedge the autosave's in-flight guard indefinitely.
export function putDocContent(
  id: string,
  content: DocContent,
  opts: { explicit?: boolean; signal?: AbortSignal } = {}
): Promise<{ revisionId: string; byteSize: number; contentHash: string }> {
  const qs = opts.explicit === false ? '?mode=autosave' : ''
  return request(
    `/api/docs/${encodeURIComponent(id)}/content${qs}`,
    (b) => PutContentResult.parse(b),
    {
      method: 'PUT',
      body: JSON.stringify(DocContent.parse(content)),
      signal: opts.signal
    }
  )
}

export function fetchRevisions(id: string, signal?: AbortSignal): Promise<RevisionSummary[]> {
  return request(`/api/docs/${encodeURIComponent(id)}/revisions`, (b) => RevisionList.parse(b), {
    signal
  })
}

export function restoreRevision(
  id: string,
  body: RestoreRequest
): Promise<{ revisionId: string }> {
  return request(`/api/docs/${encodeURIComponent(id)}/restore`, (b) => RestoreResult.parse(b), {
    method: 'POST',
    body: JSON.stringify(RestoreRequest.parse(body))
  })
}

export function fetchRevisionContent(
  id: string,
  revisionId: string,
  signal?: AbortSignal
): Promise<DocContent> {
  return request(
    `/api/docs/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/content`,
    (b) => DocContent.parse(b),
    { signal }
  )
}

// ----- link graph ---------------------------------------------------------

// Incoming references + outgoing links (with resolved targets) for the rail.
// Populated on reindex, so a just-saved doc shows links after its next pass.
export function fetchDocLinks(id: string, signal?: AbortSignal): Promise<DocLinksResponse> {
  return request(`/api/docs/${encodeURIComponent(id)}/links`, (b) => DocLinksResponse.parse(b), {
    signal
  })
}

// ----- lock toggle --------------------------------------------------------

export function setDocLocked(id: string, body: SetLockedRequest): Promise<void> {
  return request(`/api/docs/${encodeURIComponent(id)}/lock`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(SetLockedRequest.parse(body))
  })
}

// ----- folders ------------------------------------------------------------

export function renameFolder(
  body: FolderRenameRequest
): Promise<{ moved: number; ids: string[] }> {
  return request(
    '/api/folders',
    (b) => z.object({ moved: z.number(), ids: z.array(z.string()) }).parse(b),
    {
      method: 'PATCH',
      body: JSON.stringify(FolderRenameRequest.parse(body))
    }
  )
}

export function deleteFolder(path: string): Promise<void> {
  // The backend takes a base64url-encoded path so the leading "/"
  // doesn't tangle with route parsing.
  const enc = base64UrlEncode(path)
  return request(`/api/folders/${enc}`, () => undefined, { method: 'DELETE' })
}

function base64UrlEncode(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ----- per-doc ACL --------------------------------------------------------

export function fetchDocEditors(id: string, signal?: AbortSignal): Promise<DocEditorsResponse> {
  return request(
    `/api/docs/${encodeURIComponent(id)}/editors`,
    (b) => DocEditorsResponse.parse(b),
    {
      signal
    }
  )
}

export function addDocEditor(id: string, body: AddEditorRequest): Promise<void> {
  return request(`/api/docs/${encodeURIComponent(id)}/editors`, () => undefined, {
    method: 'POST',
    body: JSON.stringify(AddEditorRequest.parse(body))
  })
}

export function removeDocEditor(
  id: string,
  scope: 'user' | 'everyone',
  scopeId: string
): Promise<void> {
  const base = `/api/docs/${encodeURIComponent(id)}/editors`
  // 'everyone' is a singleton on a doc — the server route has no
  // :scopeId segment for it. 'user' carries the userId in the path.
  const path =
    scope === 'everyone' ? `${base}/everyone` : `${base}/user/${encodeURIComponent(scopeId)}`
  return request(path, () => undefined, { method: 'DELETE' })
}

// ----- user directory -----------------------------------------------------

export function searchUsers(emailPrefix: string, signal?: AbortSignal): Promise<UserSearchResult> {
  const qs = new URLSearchParams({ email: emailPrefix })
  return request(`/api/users?${qs}`, (b) => UserSearchResult.parse(b), { signal })
}

// ----- doc tags -----------------------------------------------------------

export function fetchDocTags(id: string, signal?: AbortSignal): Promise<DocTags> {
  return request(`/api/docs/${encodeURIComponent(id)}/tags`, (b) => DocTags.parse(b), { signal })
}

export function putDocTags(id: string, tags: DocTags): Promise<void> {
  return request(`/api/docs/${encodeURIComponent(id)}/tags`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(DocTags.parse(tags))
  })
}

// Org-wide free-form tag vocabulary (most-used first) for the editor's
// tag autocomplete.
export function fetchTagVocab(signal?: AbortSignal): Promise<TagVocab> {
  return request('/api/tags', (b) => TagVocab.parse(b), { signal })
}
