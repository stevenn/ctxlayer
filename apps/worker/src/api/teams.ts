/**
 * Public-read endpoints for teams + products. Used by the editor's
 * tag pane to populate multi-selects. Admin CRUD lives in
 * api/admin-teams.ts + api/admin-products.ts.
 */

import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { listTeams } from '../db/queries/teams'
import { listProducts } from '../db/queries/products'

export const teamsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
teamsRoute.use('*', requireUser)
teamsRoute.use('*', requireCsrf)

teamsRoute.get('/', async (c) => c.json(await listTeams(c.env)))

export const productsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
productsRoute.use('*', requireUser)
productsRoute.use('*', requireCsrf)

productsRoute.get('/', async (c) => c.json(await listProducts(c.env)))
