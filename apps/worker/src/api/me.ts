import { Hono } from 'hono'
import type { Env } from '../env'

export const meRoute = new Hono<{ Bindings: Env }>()

// Real implementation arrives with M1 sign-in work. For the skeleton we
// return 401 so the SPA correctly routes unauthenticated users to /sign-in.
meRoute.get('/', (c) => c.json({ error: 'not_signed_in' }, 401))
