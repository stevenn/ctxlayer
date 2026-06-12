import {
  AddTeamMemberRequest,
  AdminRoleRow,
  AdminTeamRow,
  CreateProductRequest,
  CreateRoleRequest,
  CreateTeamRequest,
  ProductRef,
  RoleRef,
  SetUserRolesRequest,
  TeamMemberRow,
  TeamProductsAssignment,
  TeamProductsPayload,
  TeamRef,
  UpdateProductRequest,
  UpdateRoleRequest,
  UpdateTeamRequest
} from '@ctxlayer/shared'
import { z } from 'zod'
import { request } from './core'

// ----- teams + products (public-read) ------------------------------------

const TeamList = z.array(TeamRef)
const ProductList = z.array(ProductRef)
const RoleList = z.array(RoleRef)
const TeamMemberList = z.array(TeamMemberRow)
const TeamProductsList = z.array(TeamProductsAssignment)

export function fetchTeams(signal?: AbortSignal): Promise<TeamRef[]> {
  return request('/api/teams', (b) => TeamList.parse(b), { signal })
}

export function fetchProducts(signal?: AbortSignal): Promise<ProductRef[]> {
  return request('/api/products', (b) => ProductList.parse(b), { signal })
}

export function fetchRoles(signal?: AbortSignal): Promise<RoleRef[]> {
  return request('/api/roles', (b) => RoleList.parse(b), { signal })
}

// ----- admin teams --------------------------------------------------------

const AdminTeamList = z.array(AdminTeamRow)

export function fetchAdminTeams(signal?: AbortSignal): Promise<AdminTeamRow[]> {
  return request('/api/admin/teams', (b) => AdminTeamList.parse(b), { signal })
}

export function adminCreateTeam(input: CreateTeamRequest): Promise<AdminTeamRow> {
  return request('/api/admin/teams', (b) => AdminTeamRow.parse(b), {
    method: 'POST',
    body: JSON.stringify(CreateTeamRequest.parse(input))
  })
}

export function adminPatchTeam(id: string, patch: UpdateTeamRequest): Promise<void> {
  return request(`/api/admin/teams/${encodeURIComponent(id)}`, () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateTeamRequest.parse(patch))
  })
}

export function adminDeleteTeam(id: string): Promise<void> {
  return request(`/api/admin/teams/${encodeURIComponent(id)}`, () => undefined, {
    method: 'DELETE'
  })
}

export function fetchTeamMembers(id: string, signal?: AbortSignal): Promise<TeamMemberRow[]> {
  return request(
    `/api/admin/teams/${encodeURIComponent(id)}/members`,
    (b) => TeamMemberList.parse(b),
    { signal }
  )
}

export function addTeamMember(teamId: string, body: AddTeamMemberRequest): Promise<void> {
  return request(`/api/admin/teams/${encodeURIComponent(teamId)}/members`, () => undefined, {
    method: 'POST',
    body: JSON.stringify(AddTeamMemberRequest.parse(body))
  })
}

export function removeTeamMember(teamId: string, userId: string): Promise<void> {
  const path = `/api/admin/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`
  return request(path, () => undefined, { method: 'DELETE' })
}

// ----- admin roles --------------------------------------------------------

const AdminRoleList = z.array(AdminRoleRow)

export function fetchAdminRoles(signal?: AbortSignal): Promise<AdminRoleRow[]> {
  return request('/api/admin/roles', (b) => AdminRoleList.parse(b), { signal })
}

export function adminCreateRole(input: CreateRoleRequest): Promise<RoleRef> {
  return request('/api/admin/roles', (b) => RoleRef.parse(b), {
    method: 'POST',
    body: JSON.stringify(CreateRoleRequest.parse(input))
  })
}

export function adminPatchRole(id: string, patch: UpdateRoleRequest): Promise<void> {
  return request(`/api/admin/roles/${encodeURIComponent(id)}`, () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateRoleRequest.parse(patch))
  })
}

export function adminDeleteRole(id: string): Promise<void> {
  return request(`/api/admin/roles/${encodeURIComponent(id)}`, () => undefined, { method: 'DELETE' })
}

export function putUserRoles(userId: string, roleIds: string[]): Promise<void> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}/roles`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(SetUserRolesRequest.parse({ roleIds }))
  })
}

// ----- admin products + team↔product matrix ------------------------------

export function adminCreateProduct(input: CreateProductRequest): Promise<ProductRef> {
  return request('/api/admin/products', (b) => ProductRef.parse(b), {
    method: 'POST',
    body: JSON.stringify(CreateProductRequest.parse(input))
  })
}

export function adminPatchProduct(id: string, patch: UpdateProductRequest): Promise<void> {
  return request(`/api/admin/products/${encodeURIComponent(id)}`, () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateProductRequest.parse(patch))
  })
}

export function adminDeleteProduct(id: string): Promise<void> {
  return request(`/api/admin/products/${encodeURIComponent(id)}`, () => undefined, {
    method: 'DELETE'
  })
}

export function fetchTeamProducts(signal?: AbortSignal): Promise<TeamProductsAssignment[]> {
  return request('/api/admin/team-products', (b) => TeamProductsList.parse(b), { signal })
}

export function putTeamProducts(rules: TeamProductsAssignment[]): Promise<void> {
  return request('/api/admin/team-products', () => undefined, {
    method: 'PUT',
    body: JSON.stringify(TeamProductsPayload.parse({ rules }))
  })
}
