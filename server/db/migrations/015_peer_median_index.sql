-- 015_peer_median_index.sql
-- Composite index for the getPeerMedianForPilot as-of LATERAL join.
-- Covers: fleet_session_id + ship_type_id filter, then character_id + recorded_at DESC
-- for the DISTINCT ON (character_id) ... ORDER BY character_id, recorded_at DESC pattern.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ps_peer_median
  ON pilot_snapshots (fleet_session_id, ship_type_id, character_id, recorded_at DESC);
