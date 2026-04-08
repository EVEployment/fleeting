import { query } from '../pg.js';

export async function createFleet({
  name,
  eveFleetId,
  fcCharacterId,
}: {
  name: string;
  eveFleetId?: bigint | null;
  fcCharacterId: number;
}) {
  const { rows } = await query(
    `INSERT INTO fleet_sessions (name, eve_fleet_id, fc_character_id)
     VALUES ($1, $2, $3) RETURNING *`,
    [name, eveFleetId ?? null, fcCharacterId],
  );
  return rows[0];
}

export async function getFleetById(id: string) {
  const { rows } = await query('SELECT * FROM fleet_sessions WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function getOpenFleets() {
  const { rows } = await query('SELECT * FROM fleet_sessions WHERE is_open = TRUE');
  return rows;
}

export async function getFleetsByFc(fcCharacterId: number) {
  const { rows } = await query(
    'SELECT * FROM fleet_sessions WHERE fc_character_id = $1 ORDER BY created_at DESC',
    [fcCharacterId],
  );
  return rows;
}

export async function closeFleet(id: string) {
  await query(
    `UPDATE fleet_sessions SET is_open = FALSE, closed_at = NOW() WHERE id = $1`,
    [id],
  );
}

export async function deleteFleet(id: string) {
  await query('DELETE FROM fleet_sessions WHERE id = $1', [id]);
}

export async function getAllFleets({ page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const { rows } = await query(
    `SELECT fs.*,
            COUNT(DISTINCT fm.character_id) AS member_count
       FROM fleet_sessions fs
       LEFT JOIN fleet_members fm ON fm.fleet_session_id = fs.id
      GROUP BY fs.id
      ORDER BY fs.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

/** Strict UUID v4 pattern — prevents SQL identifier injection */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(id: string, label: string): void {
  if (!UUID_RE.test(id)) {
    throw new Error(`Invalid ${label}: expected UUID v4`);
  }
}

export async function createPartitionForFleet(fleetSessionId: string) {
  assertUuid(fleetSessionId, 'fleetSessionId');
  const safeName = fleetSessionId.replace(/-/g, '_');
  await query(
    `CREATE TABLE IF NOT EXISTS combat_events_${safeName}
       PARTITION OF combat_events
       FOR VALUES IN ($1)`,
    [fleetSessionId],
  );
}
