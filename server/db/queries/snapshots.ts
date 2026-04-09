import { query } from '../pg.js';

interface SnapshotRow {
  fleetSessionId: string;
  characterId: number;
  recordedAt?: Date;
  dpsOut: number;
  dpsIn: number;
  logiOut: number;
  logiIn: number;
  capTransferred: number;
  capReceived: number;
  capDamageOut: number;
  capDamageIn: number;
  mined: number;
  dmgOutP50: number;
  dmgOutP90: number;
  dmgOutP95: number;
  dmgOutP99: number;
  dmgOutAvg: number;
  dmgOutMedian: number;
  hitQualityDist?: Record<string, number> | null;
  shipTypeId?: number;
  solarSystemId?: number;
}

export async function insert(row: SnapshotRow) {
  await query(
    `INSERT INTO pilot_snapshots
       (fleet_session_id, character_id, recorded_at,
        dps_out, dps_in, logi_out, logi_in,
        cap_transferred, cap_received, cap_damage_out, cap_damage_in, mined,
        dmg_out_p50, dmg_out_p90, dmg_out_p95, dmg_out_p99, dmg_out_avg, dmg_out_median,
        hit_quality_dist, ship_type_id, solar_system_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [
      row.fleetSessionId, row.characterId, row.recordedAt ?? new Date(),
      row.dpsOut, row.dpsIn, row.logiOut, row.logiIn,
      row.capTransferred, row.capReceived, row.capDamageOut, row.capDamageIn, row.mined,
      row.dmgOutP50, row.dmgOutP90, row.dmgOutP95, row.dmgOutP99, row.dmgOutAvg, row.dmgOutMedian,
      row.hitQualityDist ? JSON.stringify(row.hitQualityDist) : null,
      row.shipTypeId ?? null,
      row.solarSystemId ?? null,
    ],
  );
}

export async function getForPilot(fleetSessionId: string, characterId: number) {
  const { rows } = await query(
    `SELECT * FROM pilot_snapshots
      WHERE fleet_session_id = $1 AND character_id = $2
      ORDER BY recorded_at`,
    [fleetSessionId, characterId],
  );
  return rows;
}

/**
 * Get the most recent snapshot for each pilot at or before a given timestamp.
 * Used by history replay scrub to reconstruct fleet state at a point in time.
 */
/**
 * For each of the selected pilot's snapshots, find the as-of peer median DPS
 * among same-ship-type pilots. Uses a 15s freshness window to avoid stale data.
 * Excludes pilots with dps_out < 5 (MIN_ACTIVE_DPS).
 */
export async function getPeerMedianForPilot(fleetSessionId: string, characterId: number) {
  const { rows } = await query(
    `WITH anchor AS (
       SELECT recorded_at, ship_type_id
         FROM pilot_snapshots
        WHERE fleet_session_id = $1 AND character_id = $2
        ORDER BY recorded_at
     )
     SELECT a.recorded_at,
            a.ship_type_id,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY peer.dps_out) AS median_dps,
            COUNT(peer.*)::int AS peer_count
       FROM anchor a
       LEFT JOIN LATERAL (
         SELECT DISTINCT ON (ps.character_id) ps.dps_out
           FROM pilot_snapshots ps
          WHERE ps.fleet_session_id = $1
            AND ps.character_id != $2
            AND ps.ship_type_id = a.ship_type_id
            AND ps.recorded_at <= a.recorded_at
            AND ps.recorded_at >= a.recorded_at - INTERVAL '15 seconds'
            AND ps.dps_out >= 5
          ORDER BY ps.character_id, ps.recorded_at DESC
       ) peer ON true
      GROUP BY a.recorded_at, a.ship_type_id
      ORDER BY a.recorded_at`,
    [fleetSessionId, characterId],
  );
  return rows;
}

export async function getFleetSnapshotAt(fleetSessionId: string, at: Date) {
  const { rows } = await query(
    `SELECT DISTINCT ON (character_id)
            character_id, dps_out, dps_in, logi_out, logi_in,
            cap_transferred, cap_received, cap_damage_out, cap_damage_in, mined,
            ship_type_id, solar_system_id, hit_quality_dist, recorded_at
       FROM pilot_snapshots
      WHERE fleet_session_id = $1
        AND recorded_at <= $2
      ORDER BY character_id, recorded_at DESC`,
    [fleetSessionId, at],
  );
  return rows;
}
