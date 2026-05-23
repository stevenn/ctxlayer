import { Hono } from 'hono'
import type { Env } from '../env'
import type { VersionResponse } from '@ctxlayer/shared'

export const versionRoute = new Hono<{ Bindings: Env }>()

versionRoute.get('/', (c) => {
  const body: VersionResponse = {
    gitSha: '',
    builtAt: ''
  }
  return c.json(body)
})
