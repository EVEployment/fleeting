-- 014: Add ship_type_id and solar_system_id to pilot_snapshots.
-- pilot_timeline intentionally excluded — its UPSERT running-average semantics
-- conflict with single-value ship_type_id when a pilot reshipped mid-bucket.
-- Historical peer efficiency uses pilot_snapshots (5s granularity) instead.

ALTER TABLE pilot_snapshots ADD COLUMN IF NOT EXISTS ship_type_id INT;
ALTER TABLE pilot_snapshots ADD COLUMN IF NOT EXISTS solar_system_id INT;

-- Index for peer efficiency queries: "all pilots with ship_type X in fleet Y"
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ps_fleet_ship
  ON pilot_snapshots (fleet_session_id, ship_type_id);
