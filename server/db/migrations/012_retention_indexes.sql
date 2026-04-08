-- 012_retention_indexes.sql
-- Indexes to support the daily retention cleanup job.
-- Without these, DELETE...WHERE recorded_at < $1 does a sequential scan.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pilot_snapshots_recorded_at
  ON pilot_snapshots (recorded_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pilot_timeline_bucket_at
  ON pilot_timeline (bucket_at);
