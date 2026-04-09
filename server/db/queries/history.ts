import { query } from '../pg.js';

// Ship group IDs considered non-combat for participation analysis
const NON_COMBAT_GROUP_IDS = [29, 31, 22, 380, 513, 902, 463, 543, 941, 1022, 237, 1];

export async function getFleetList({ page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;

  const [{ rows }, { rows: countRows }] = await Promise.all([
    query(
      `WITH page AS (
         SELECT id, name, created_at, closed_at, is_open
           FROM fleet_sessions
          ORDER BY created_at DESC
          LIMIT $1 OFFSET $2
       )
       SELECT p.*,
              members.member_count,
              dps.avg_dps_out,
              comp.ship_type_ids
         FROM page p
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT fm.character_id)::int AS member_count
             FROM fleet_members fm
            WHERE fm.fleet_session_id = p.id
         ) members ON true
         LEFT JOIN LATERAL (
           SELECT ROUND(AVG(ps.dps_out)::numeric, 2) AS avg_dps_out
             FROM pilot_snapshots ps
            WHERE ps.fleet_session_id = p.id
         ) dps ON true
         LEFT JOIN LATERAL (
           SELECT array_agg(latest.ship_type_id) AS ship_type_ids
             FROM (
               SELECT DISTINCT ON (mp.character_id) mp.ship_type_id
                 FROM member_presence mp
                WHERE mp.fleet_session_id = p.id
                  AND mp.ship_type_id IS NOT NULL
                ORDER BY mp.character_id, mp.recorded_at DESC
             ) latest
         ) comp ON true
        ORDER BY p.created_at DESC`,
      [limit, offset],
    ),
    query(`SELECT COUNT(*)::int AS total FROM fleet_sessions`),
  ]);

  return { fleets: rows, total: countRows[0]?.total ?? 0 };
}

export async function getFleetSummary(fleetSessionId: string) {
  const { rows } = await query(
    `SELECT
        source_character_id AS character_id,
        COUNT(*)::int                          AS total_hits,
        ROUND(AVG(amount)::numeric, 0)         AS avg_hit,
        SUM(amount)::bigint                    AS total_damage,
        MAX(weapon_type)                       AS top_weapon
     FROM combat_events
     WHERE fleet_session_id = $1 AND category = 'dpsOut'
     GROUP BY source_character_id
     ORDER BY total_damage DESC`,
    [fleetSessionId],
  );
  return rows;
}

export async function getFleetParticipation(fleetSessionId: string) {
  const { rows: presence } = await query(
    `SELECT character_id, solar_system_id, ship_type_id, recorded_at
       FROM member_presence
      WHERE fleet_session_id = $1
      ORDER BY character_id, recorded_at`,
    [fleetSessionId],
  );
  if (!presence.length) return [];

  // Compute mode system across all presence records for location outlier detection
  const systemCounts = new Map<number, number>();
  for (const r of presence) {
    systemCounts.set(r.solar_system_id, (systemCounts.get(r.solar_system_id) ?? 0) + 1);
  }
  let modeSystem = -1;
  let modeCount = 0;
  for (const [sys, cnt] of systemCounts) {
    if (cnt > modeCount) { modeSystem = sys; modeCount = cnt; }
  }

  // Group records by character
  const byChar = new Map<number, typeof presence>();
  for (const r of presence) {
    if (!byChar.has(r.character_id)) byChar.set(r.character_id, []);
    byChar.get(r.character_id)!.push(r);
  }

  const results = [];
  for (const [charId, records] of byChar) {
    const total = records.length;
    const nonCombatCount = records.filter((r) => NON_COMBAT_GROUP_IDS.includes(r.ship_type_id)).length;
    const outlierCount = records.filter((r) => r.solar_system_id !== modeSystem).length;
    const nonCombatPct = nonCombatCount / total;
    const outlierPct = outlierCount / total;

    let verdict: 'participant' | 'partial' | 'non-participant' = 'participant';
    if (nonCombatPct > 0.5 || outlierPct > 0.5) verdict = 'non-participant';
    else if (nonCombatPct > 0.2 || outlierPct > 0.2) verdict = 'partial';

    results.push({
      characterId: charId,
      shipNonCombatPct: Math.round(nonCombatPct * 100),
      locationOutlierPct: Math.round(outlierPct * 100),
      verdict,
    });
  }
  return results;
}
