import { query } from '../pg.js';

interface PresenceRecord {
  fleetSessionId: string;
  characterId: number;
  solarSystemId: number;
  shipTypeId: number;
}

export async function insertPresenceBatch(records: PresenceRecord[]) {
  if (!records.length) return;

  const values: string[] = [];
  const params: unknown[] = [];
  let n = 1;
  for (const r of records) {
    values.push(`($${n++}, $${n++}, $${n++}, $${n++})`);
    params.push(r.fleetSessionId, r.characterId, r.solarSystemId, r.shipTypeId);
  }

  await query(
    `INSERT INTO member_presence (fleet_session_id, character_id, solar_system_id, ship_type_id)
     VALUES ${values.join(',')}`,
    params,
  );
}

export async function getPresenceTimeline(fleetSessionId: string, characterId: number | null = null) {
  if (characterId !== null) {
    const { rows } = await query(
      `SELECT * FROM member_presence
        WHERE fleet_session_id = $1 AND character_id = $2
        ORDER BY recorded_at`,
      [fleetSessionId, characterId],
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT * FROM member_presence WHERE fleet_session_id = $1 ORDER BY recorded_at`,
    [fleetSessionId],
  );
  return rows;
}

export async function getFleetSystemSnapshot(fleetSessionId: string, at: Date | null = null) {
  const timeFilter = at ? '$2' : 'NOW()';
  const params: unknown[] = at ? [fleetSessionId, at] : [fleetSessionId];

  const { rows } = await query(
    `SELECT DISTINCT ON (character_id)
            character_id, solar_system_id, ship_type_id, recorded_at
       FROM member_presence
      WHERE fleet_session_id = $1
        AND recorded_at <= ${timeFilter}
      ORDER BY character_id, recorded_at DESC`,
    params,
  );
  return rows;
}

export async function touchFleetMembers(fleetSessionId: string, characterIds: number[]) {
  if (!characterIds.length) return;

  // Build placeholders: each row is (fleet_session_id, character_id)
  const values = characterIds.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(',');
  const params = characterIds.flatMap((id) => [fleetSessionId, id]);

  await query(
    `INSERT INTO fleet_members (fleet_session_id, character_id)
     VALUES ${values}
     ON CONFLICT (fleet_session_id, character_id)
     DO UPDATE SET last_seen = NOW(), is_active = TRUE`,
    params,
  );
}

export async function getLatestPresence(
  fleetSessionId: string,
  characterId: number,
): Promise<{ shipTypeId: number; solarSystemId: number } | null> {
  const { rows } = await query(
    `SELECT ship_type_id, solar_system_id
       FROM member_presence
      WHERE fleet_session_id = $1 AND character_id = $2
      ORDER BY recorded_at DESC
      LIMIT 1`,
    [fleetSessionId, characterId],
  );
  if (!rows.length) return null;
  return { shipTypeId: rows[0].ship_type_id, solarSystemId: rows[0].solar_system_id };
}

export async function upsertFleetMember(fleetSessionId: string, characterId: number) {
  await query(
    `INSERT INTO fleet_members (fleet_session_id, character_id)
     VALUES ($1, $2)
     ON CONFLICT (fleet_session_id, character_id)
     DO UPDATE SET last_seen = NOW(), is_active = TRUE`,
    [fleetSessionId, characterId],
  );
}
