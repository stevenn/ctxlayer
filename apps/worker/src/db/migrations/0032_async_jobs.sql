-- 0032_async_jobs.sql
--
-- Async submit→poll for slow upstream tools. A tool listed in an upstream's
-- authConfig.asyncTools is NOT run inline — a 2-3 min call would blow past an
-- interactive client's hard request timeout (Claude Desktop caps at ~180s and
-- does not reset on progress, so no server-side keepalive helps). Instead the
-- proxy enqueues a job, returns a token, and the ctxlayer-jobs queue consumer
-- runs the full upstream call with a generous wall-clock budget and stores the
-- result here for poll_task to fetch. See docs/plan/I-upstream-resilience.md §I9.
--
-- Deliberately FK-free (soft user_id / upstream_id refs, exactly like
-- usage_events): an FK would make async_jobs a NOT-NULL NO-ACTION child of
-- upstream_servers / users and reintroduce the G1 parent-rebuild landmine
-- (see docs/plan/G-conventions.md §G1). Rows are pruned by age in the nightly
-- cron, so lingering rows after a user/upstream delete are harmless.

CREATE TABLE async_jobs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL DEFAULT '',
  upstream_id   TEXT NOT NULL,
  tool          TEXT NOT NULL,             -- native upstream tool name (to re-dial)
  job_key       TEXT NOT NULL,             -- sha256(user, upstream, tool, argsJson)
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'done', 'error')),
  result_json   TEXT,                      -- JSON content array (status='done')
  error_code    TEXT,                      -- coarse class (status='error')
  error_detail  TEXT,                      -- credential-scrubbed message (status='error')
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
);

-- At most one RUNNING job per key: concurrent identical submits attach to the
-- existing job instead of spawning duplicates. done/error rows do NOT
-- participate, so a completed job never blocks a later resubmit of the same call.
CREATE UNIQUE INDEX idx_async_jobs_running_key ON async_jobs (job_key) WHERE status = 'running';

-- Submit dedup lookup (latest row for a key) + retry-warm cache hit.
CREATE INDEX idx_async_jobs_key ON async_jobs (job_key, created_at);

-- list_tasks (caller's recent jobs) + nightly age prune.
CREATE INDEX idx_async_jobs_user ON async_jobs (user_id, created_at);
