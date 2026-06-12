import {
  AdminUpstreamRow,
  CreateUpstreamRequest,
  PasteBearerRequest,
  RefreshToolsResponse,
  ReplaceToolAccessRequest,
  ReplaceVisibilityRequest,
  UpdateUpstreamRequest,
  UpstreamToolAccessResponse,
  UpstreamToolsResponse,
  UserUpstreamSummary
} from '@ctxlayer/shared'
import type { ToolAccessRule } from '@ctxlayer/shared'
import { z } from 'zod'
import { request } from './core'

// ----- admin upstreams ----------------------------------------------------

const AdminUpstreamList = z.array(AdminUpstreamRow)

export function fetchAdminUpstreams(signal?: AbortSignal): Promise<AdminUpstreamRow[]> {
  return request('/api/admin/upstreams', (b) => AdminUpstreamList.parse(b), { signal })
}

export function fetchAdminUpstream(id: string, signal?: AbortSignal): Promise<AdminUpstreamRow> {
  return request(
    `/api/admin/upstreams/${encodeURIComponent(id)}`,
    (b) => AdminUpstreamRow.parse(b),
    { signal }
  )
}

export function adminCreateUpstream(input: CreateUpstreamRequest): Promise<AdminUpstreamRow> {
  return request('/api/admin/upstreams', (b) => AdminUpstreamRow.parse(b), {
    method: 'POST',
    body: JSON.stringify(CreateUpstreamRequest.parse(input))
  })
}

export function adminPatchUpstream(id: string, patch: UpdateUpstreamRequest): Promise<void> {
  return request(`/api/admin/upstreams/${encodeURIComponent(id)}`, () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateUpstreamRequest.parse(patch))
  })
}

export function adminDeleteUpstream(id: string): Promise<void> {
  return request(`/api/admin/upstreams/${encodeURIComponent(id)}`, () => undefined, {
    method: 'DELETE'
  })
}

export function adminPutUpstreamVisibility(
  id: string,
  body: ReplaceVisibilityRequest
): Promise<void> {
  return request(`/api/admin/upstreams/${encodeURIComponent(id)}/visibility`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(ReplaceVisibilityRequest.parse(body))
  })
}

export function adminRefreshUpstreamTools(id: string): Promise<RefreshToolsResponse> {
  return request(
    `/api/admin/upstreams/${encodeURIComponent(id)}/refresh-tools`,
    (b) => RefreshToolsResponse.parse(b),
    { method: 'POST' }
  )
}

export function fetchAdminUpstreamTools(
  id: string,
  signal?: AbortSignal
): Promise<UpstreamToolsResponse> {
  return request(
    `/api/admin/upstreams/${encodeURIComponent(id)}/tools`,
    (b) => UpstreamToolsResponse.parse(b),
    { signal }
  )
}

export function fetchUpstreamToolAccess(
  id: string,
  signal?: AbortSignal
): Promise<UpstreamToolAccessResponse> {
  return request(
    `/api/admin/upstreams/${encodeURIComponent(id)}/tool-access`,
    (b) => UpstreamToolAccessResponse.parse(b),
    { signal }
  )
}

export function putUpstreamToolAccess(
  id: string,
  toolName: string,
  rules: ToolAccessRule[]
): Promise<void> {
  return request(`/api/admin/upstreams/${encodeURIComponent(id)}/tool-access`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(ReplaceToolAccessRequest.parse({ toolName, rules }))
  })
}

export function adminPutSharedCredentials(id: string, body: PasteBearerRequest): Promise<void> {
  return request(
    `/api/admin/upstreams/${encodeURIComponent(id)}/shared-credentials`,
    () => undefined,
    {
      method: 'PUT',
      body: JSON.stringify(PasteBearerRequest.parse(body))
    }
  )
}

export function adminDeleteSharedCredentials(id: string): Promise<void> {
  return request(
    `/api/admin/upstreams/${encodeURIComponent(id)}/shared-credentials`,
    () => undefined,
    { method: 'DELETE' }
  )
}

// ----- upstreams (user-facing) --------------------------------------------

const UserUpstreamList = z.array(UserUpstreamSummary)

export function fetchUpstreams(signal?: AbortSignal): Promise<UserUpstreamSummary[]> {
  return request('/api/upstreams', (b) => UserUpstreamList.parse(b), { signal })
}

export function fetchUserUpstreamTools(
  id: string,
  signal?: AbortSignal
): Promise<UpstreamToolsResponse> {
  return request(
    `/api/upstreams/${encodeURIComponent(id)}/tools`,
    (b) => UpstreamToolsResponse.parse(b),
    { signal }
  )
}

export function putUpstreamCredentials(
  upstreamId: string,
  body: PasteBearerRequest
): Promise<void> {
  return request(`/api/upstreams/${encodeURIComponent(upstreamId)}/credentials`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(PasteBearerRequest.parse(body))
  })
}

export function deleteUpstreamCredentials(upstreamId: string): Promise<void> {
  return request(`/api/upstreams/${encodeURIComponent(upstreamId)}/credentials`, () => undefined, {
    method: 'DELETE'
  })
}
