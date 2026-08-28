-- Run ledger for recurring batch jobs (cron tasks + git-sync runs),
-- powering Admin · Jobs. One row per run. Before this, cron outcomes
-- lived only in console logs (evaporate) and git-sync overwrote its
-- per-source status on every run — no history to debug from.
-- Rows are pruned after 90 days by the nightly 'jobs-prune' task.
CREATE TABLE job_runs (
  id          TEXT PRIMARY KEY,
  task        TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'error')),
  summary     TEXT,  -- task-specific counts, JSON ({"warmed":3,"due":5})
  error       TEXT   -- scrubbed failure detail; NULL on ok
);
CREATE INDEX idx_job_runs_ts ON job_runs(started_at DESC);
CREATE INDEX idx_job_runs_task_ts ON job_runs(task, started_at DESC);
