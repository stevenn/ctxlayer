import { z } from 'zod'
import { UsageRange } from './usage'

// ----- Admin · Jobs: recurring-batch-job run ledger ------------------------
// One row per execution of a cron task or git-sync run (worker table
// `job_runs`). `summary` is task-specific counts (e.g. {warmed: 3, due: 5}
// for keep-warm, {created, updated, …} for git-sync); `error` is the
// scrubbed failure detail. 'partial' = ran but some units failed
// (git-sync conflicts, keep-warm failures).
export const JobRunStatus = z.enum(['ok', 'partial', 'error'])
export type JobRunStatus = z.infer<typeof JobRunStatus>

export const JobRunRow = z.object({
  id: z.string(),
  task: z.string(),
  startedAt: z.number().int(), // unix seconds
  durationMs: z.number().int().min(0),
  status: JobRunStatus,
  summary: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable()
})
export type JobRunRow = z.infer<typeof JobRunRow>

export const AdminJobsResponse = z.object({
  range: UsageRange,
  runs: z.array(JobRunRow)
})
export type AdminJobsResponse = z.infer<typeof AdminJobsResponse>
