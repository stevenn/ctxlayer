/**
 * Admin REST for the Jobs dashboard. `GET /api/admin/jobs?range=30d&task=
 * git-sync` returns the recorded runs of recurring batch jobs (cron tasks
 * + git-sync runs) within the window, newest-first. Read-only; rows are
 * written by `ops/job-runs.ts:recordJobRun` at each job site.
 */

import { Hono } from 'hono'
import type { AdminJobsResponse } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { listJobRuns } from '../db/queries/job-runs'
import { rangeCutoff } from '../db/queries/usage-read'
import { parseRange, parseOffset } from './usage'

/** Runs returned per request — the ledger is bounded, but cap the wire. */
const RUNS_LIMIT = 1000

export const adminJobsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
adminJobsRoute.use('*', requireAdmin)

adminJobsRoute.get('/', async (c) => {
  const url = new URL(c.req.url)
  const range = parseRange(url.searchParams.get('range'))
  const offsetSec = parseOffset(url.searchParams.get('tz'))
  const task = url.searchParams.get('task')?.trim() || undefined
  const body: AdminJobsResponse = {
    range,
    runs: await listJobRuns(c.env, {
      since: rangeCutoff(range, offsetSec) ?? 0,
      task,
      limit: RUNS_LIMIT
    })
  }
  return c.json(body)
})
