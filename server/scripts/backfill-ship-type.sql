-- backfill-ship-type.sql
-- Backfill ship_type_id and solar_system_id into pilot_snapshots from member_presence.
-- Uses as-of join: for each snapshot, find the most recent presence record AT OR BEFORE
-- the snapshot's recorded_at. This respects ship changes mid-fight (30s granularity).
--
-- Usage: psql -d peld -f server/scripts/backfill-ship-type.sql
-- Safe to run multiple times (only updates NULL rows).

-- Use a CTE with LATERAL join for correct as-of semantics
UPDATE pilot_snapshots ps
SET ship_type_id    = mp.ship_type_id,
    solar_system_id = mp.solar_system_id
FROM LATERAL (
  SELECT ship_type_id, solar_system_id
    FROM member_presence
   WHERE fleet_session_id = ps.fleet_session_id
     AND character_id     = ps.character_id
     AND recorded_at     <= ps.recorded_at
   ORDER BY recorded_at DESC
   LIMIT 1
) mp
WHERE ps.ship_type_id IS NULL;

-- Report results
DO $$
DECLARE
  total_rows  BIGINT;
  filled_rows BIGINT;
  null_rows   BIGINT;
BEGIN
  SELECT COUNT(*) INTO total_rows  FROM pilot_snapshots;
  SELECT COUNT(*) INTO filled_rows FROM pilot_snapshots WHERE ship_type_id IS NOT NULL;
  SELECT COUNT(*) INTO null_rows   FROM pilot_snapshots WHERE ship_type_id IS NULL;
  RAISE NOTICE 'Backfill complete: % total, % filled, % still NULL (no matching presence)',
    total_rows, filled_rows, null_rows;
END $$;
