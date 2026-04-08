import { query } from '../pg.js';

interface TimelineRow {
  fleetSessionId: string;
  characterId: number;
  bucketAt: Date | string;
  avgDpsOut: number;
  maxDpsOut: number;
  avgDpsIn: number;
  avgLogiOut: number;
  avgLogiIn: number;
  avgCapTransferred: number;
  avgCapReceived: number;
  avgCapDamageOut: number;
  avgCapDamageIn: number;
  avgMined: number;
  hitQualityDist?: Record<string, number> | null;
}

export async function upsert(row: TimelineRow) {
  await query(
    `INSERT INTO pilot_timeline
       (fleet_session_id, character_id, bucket_at,
        avg_dps_out, max_dps_out, avg_dps_in,
        avg_logi_out, avg_logi_in,
        avg_cap_transferred, avg_cap_received,
        avg_cap_damage_out, avg_cap_damage_in,
        avg_mined, hit_quality_dist, sample_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1)
     ON CONFLICT (fleet_session_id, character_id, bucket_at)
     DO UPDATE SET
       avg_dps_out          = (pilot_timeline.avg_dps_out * pilot_timeline.sample_count + EXCLUDED.avg_dps_out)
                              / (pilot_timeline.sample_count + 1),
       max_dps_out          = GREATEST(pilot_timeline.max_dps_out, EXCLUDED.max_dps_out),
       avg_dps_in           = (pilot_timeline.avg_dps_in * pilot_timeline.sample_count + EXCLUDED.avg_dps_in)
                              / (pilot_timeline.sample_count + 1),
       avg_logi_out         = (pilot_timeline.avg_logi_out * pilot_timeline.sample_count + EXCLUDED.avg_logi_out)
                              / (pilot_timeline.sample_count + 1),
       avg_logi_in          = (pilot_timeline.avg_logi_in * pilot_timeline.sample_count + EXCLUDED.avg_logi_in)
                              / (pilot_timeline.sample_count + 1),
       avg_cap_transferred  = (pilot_timeline.avg_cap_transferred * pilot_timeline.sample_count + EXCLUDED.avg_cap_transferred)
                              / (pilot_timeline.sample_count + 1),
       avg_cap_received     = (pilot_timeline.avg_cap_received * pilot_timeline.sample_count + EXCLUDED.avg_cap_received)
                              / (pilot_timeline.sample_count + 1),
       avg_cap_damage_out   = (pilot_timeline.avg_cap_damage_out * pilot_timeline.sample_count + EXCLUDED.avg_cap_damage_out)
                              / (pilot_timeline.sample_count + 1),
       avg_cap_damage_in    = (pilot_timeline.avg_cap_damage_in * pilot_timeline.sample_count + EXCLUDED.avg_cap_damage_in)
                              / (pilot_timeline.sample_count + 1),
       avg_mined            = (pilot_timeline.avg_mined * pilot_timeline.sample_count + EXCLUDED.avg_mined)
                              / (pilot_timeline.sample_count + 1),
       hit_quality_dist     = COALESCE(EXCLUDED.hit_quality_dist, pilot_timeline.hit_quality_dist),
       sample_count         = pilot_timeline.sample_count + 1`,
    [
      row.fleetSessionId, row.characterId, row.bucketAt,
      row.avgDpsOut, row.maxDpsOut, row.avgDpsIn,
      row.avgLogiOut, row.avgLogiIn,
      row.avgCapTransferred, row.avgCapReceived,
      row.avgCapDamageOut, row.avgCapDamageIn,
      row.avgMined,
      row.hitQualityDist ? JSON.stringify(row.hitQualityDist) : null,
    ],
  );
}

export async function getForFleet(fleetSessionId: string) {
  const { rows } = await query(
    `SELECT * FROM pilot_timeline
      WHERE fleet_session_id = $1
      ORDER BY character_id, bucket_at`,
    [fleetSessionId],
  );
  return rows;
}
