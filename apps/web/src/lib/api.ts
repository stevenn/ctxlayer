import {
  AddEditorRequest,
  ConfigResponse,
  CreateDocRequest,
  DocContent,
  DocDetail,
  DocEditorsResponse,
  DocSummary,
  HealthResponse,
  MeResponse,
  RevisionSummary,
  RestoreRequest,
  UpdateDocRequest,
  UserSearchResult
} from '@ctxlayer/shared'
import type {
  AddEditorRequest as AddEditorRequestT,
  ConfigResponse as ConfigResponseT,
  CreateDocRequest as CreateDocRequestT,
  DocContent as DocContentT,
  DocDetail as DocDetailT,
  DocEditorsResponse as DocEditorsResponseT,
  DocSummary as DocSummaryT,
  HealthResponse as HealthResponseT,
  MeResponse as MeResponseT,
  RevisionSummary as RevisionSummaryT,
  RestoreRequest as RestoreRequestT,
  UpdateDocRequest as UpdateDocRequestT,
  UserSearchResult as UserSearchResultT
} from '@ctxlayer/shared'
import { readCsrfToken } from './csrf'
import { z } from 'zod'

/** HTTP-level failure (non-2xx). */
export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`api ${status}`)
  }
}

/** Server returned 2xx but the body didn't match the expected schema. */
export class ApiSchemaError extends Error {
  constructor(public path: string, cause: unknown) {
    super(`api schema mismatch at ${path}`, { cause })
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Single fetch entry-point. Adds `credentials:'include'` so cookies
 * ride along, attaches `X-CSRF` on unsafe methods (cookie value echoed
 * — see apps/worker/src/auth/csrf.ts), and routes the response through
 * the caller's schema parser.
 */
async function request<T>(
  path: string,
  parse: (raw: unknown) => T,
  init: RequestInit & { method?: string } = {}
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (!SAFE_METHODS.has(method)) {
    const token = readCsrfToken()
    if (token) headers.set('X-CSRF', token)
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
  }
  const res = await fetch(path, { credentials: 'include', ...init, method, headers })
  // 204 No Content shortcut — the parser is called with `undefined`
  // and most callers pass `() => undefined` to satisfy void.
  if (res.status === 204) {
    try {
      return parse(undefined)
    } catch (cause) {
      throw new ApiSchemaError(path, cause)
    }
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body)
  try {
    return parse(body)
  } catch (cause) {
    throw new ApiSchemaError(path, cause)
  }
}

const VOID = z.undefined()

// ----- session-shaped reads ----------------------------------------------

export function fetchMe(signal?: AbortSignal): Promise<MeResponseT> {
  return request('/api/me', (b) => MeResponse.parse(b), { signal })
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponseT> {
  return request('/api/health', (b) => HealthResponse.parse(b), { signal })
}

export function fetchConfig(signal?: AbortSignal): Promise<ConfigResponseT> {
  return request('/api/config', (b) => ConfigResponse.parse(b), { signal })
}

export function signOut(): Promise<void> {
  return request('/api/auth/signout', () => undefined, { method: 'POST' })
}

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

export function fetchDocs(signal?: AbortSignal): Promise<DocSummaryT[]> {
  return request('/api/docs', (b) => DocList.parse(b), { signal })
}

export function createDoc(input: CreateDocRequestT): Promise<{ id: string; slug: string }> {
  return request('/api/docs', (b) => CreateDocResult.parse(b), {
    method: 'POST',
    body: JSON.stringify(CreateDocRequest.parse(input))
  })
}

export function fetchDoc(id: string, signal?: AbortSignal): Promise<DocDetailT> {
  return request(`/api/docs/${encodeURIComponent(id)}`, (b) => DocDetail.parse(b), { signal })
}

export function patchDoc(id: string, patch: UpdateDocRequestT): Promise<void> {
  return request(`/api/docs/${encodeURIComponent(id)}`, () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateDocRequest.parse(patch))
  })
}

export function deleteDoc(id: string): Promise<void> {
  return request(`/api/docs/${encodeURIComponent(id)}`, () => undefined, { method: 'DELETE' })
}

export function fetchDocContent(id: string, signal?: AbortSignal): Promise<DocContentT> {
  return request(`/api/docs/${encodeURIComponent(id)}/content`, (b) => DocContent.parse(b), {
    signal
  })
}

export function putDocContent(
  id: string,
  content: DocContentT
): Promise<{ revisionId: string; byteSize: number; contentHash: string }> {
  return request(`/api/docs/${encodeURIComponent(id)}/content`, (b) => PutContentResult.parse(b), {
    method: 'PUT',
    body: JSON.stringify(DocContent.parse(content))
  })
}

export function fetchRevisions(id: string, signal?: AbortSignal): Promise<RevisionSummaryT[]> {
  return request(`/api/docs/${encodeURIComponent(id)}/revisions`, (b) => RevisionList.parse(b), {
    signal
  })
}

export function restoreRevision(id: string, body: RestoreRequestT): Promise<{ revisionId: string }> {
  return request(`/api/docs/${encodeURIComponent(id)}/restore`, (b) => RestoreResult.parse(b), {
    method: 'POST',
    body: JSON.stringify(RestoreRequest.parse(body))
  })
}

// ----- per-doc ACL --------------------------------------------------------

export function fetchDocEditors(id: string, signal?: AbortSignal): Promise<DocEditorsResponseT> {
  return request(`/api/docs/${encodeURIComponent(id)}/editors`, (b) => DocEditorsResponse.parse(b), {
    signal
  })
}

export function addDocEditor(id: string, body: AddEditorRequestT): Promise<void> {
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

export function searchUsers(
  emailPrefix: string,
  signal?: AbortSignal
): Promise<UserSearchResultT> {
  const qs = new URLSearchParams({ email: emailPrefix })
  return request(`/api/users?${qs}`, (b) => UserSearchResult.parse(b), { signal })
}

// Silence unused warning for the VOID schema export — keeping it
// exported lets future modules adopt the same `() => undefined`
// parser shape if they need it.
export { VOID as __unusedVoid }
