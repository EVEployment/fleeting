-- 013_timeline_sample_count.sql
-- Adds sample_count to pilot_timeline to support correct running average on conflict.

ALTER TABLE pilot_timeline ADD COLUMN IF NOT EXISTS sample_count INTEGER NOT NULL DEFAULT 1;
