/**
 * Public-read endpoints for teams + products + roles. Used by the
 * editor's tag pane and the admin ACL pickers to populate multi-selects.
 * Admin CRUD lives in api/admin-teams.ts + api/admin-products.ts +
 * api/admin-roles.ts.
 */

import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { listTeams } from '../db/queries/teams'
import { listProducts } from '../db/queries/products'
import { listRoles } from '../db/queries/roles'

export const teamsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
teamsRoute.use('*', requireUser)
teamsRoute.use('*', requireCsrf)

teamsRoute.get('/', async (c) => c.json(await listTeams(c.env)))

export const productsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
productsRoute.use('*', requireUser)
productsRoute.use('*', requireCsrf)

productsRoute.get('/', async (c) => c.json(await listProducts(c.env)))

export const rolesRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
rolesRoute.use('*', requireUser)
rolesRoute.use('*', requireCsrf)

rolesRoute.get('/', async (c) => c.json(await listRoles(c.env)))
