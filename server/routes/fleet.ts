import type { FastifyInstance } from 'fastify';
import { requireAuth, requireRole, exchangeEveToken } from '../lib/auth.js';
import { ROLES } from '../lib/roles.js';
import { getFleetForCharacter } from '../lib/esi.js';
import { startTracking, stopTracking } from '../lib/memberTracker.js';
import { characterBelongsToUser } from '../db/queries/users.js';
import { getFleetSystemSnapshot, upsertFleetMember } from '../db/queries/members.js';
import * as fleets from '../db/queries/fleets.js';
import * as snapshotStore from '../store/snapshotStore.js';
import { query } from '../db/pg.js';

export default async function fleetRoutes(fastify: FastifyInstance) {
  // POST /api/fleet — FC creates a new fleet session
  fastify.post('/api/fleet', { preHandler: requireRole(ROLES.FC) }, async (req, reply) => {
    const body = req.body as Record<string, unknown> | null;
    const { name, fcCharacterId, linkEveFleet = false } = body ?? {};
    if (!name || !fcCharacterId) {
      return reply.code(400).send({ error: 'name and fcCharacterId are required' });
    }

    if (!req.session.userId) return reply.code(401).send({ error: 'Unauthorized' });
    const owned = await characterBelongsToUser(req.session.userId, fcCharacterId as number);
    if (!owned) return reply.code(403).send({ error: 'Character not owned by you' });

    let eveFleetId: bigint | null = null;
    if (linkEveFleet) {
      try {
        const token = await exchangeEveToken(fcCharacterId as number, req.session);
        const info  = await getFleetForCharacter(token, fcCharacterId as number);
        eveFleetId  = BigInt(info.fleet_id);
      } catch (err) {
        console.error('[fleet] ESI fleet lookup failed:', (err as Error).message);
        return reply.code(502).send({ error: 'ESI fleet lookup failed' });
      }
    }

    const fleet = await fleets.createFleet({
      name: name as string,
      eveFleetId,
      fcCharacterId: fcCharacterId as number,
    });

    try {
      await fleets.createPartitionForFleet(fleet.id);
    } catch (err) {
      console.error('[fleet] Partition creation failed, rolling back fleet:', (err as Error).message);
      await fleets.deleteFleet(fleet.id);
      return reply.code(500).send({ error: 'Failed to initialize fleet storage' });
    }

    if (eveFleetId) {
      const oidcAccessToken = req.session.oidcAccessToken ?? '';
      startTracking(fleet.id, fcCharacterId as number, BigInt(eveFleetId), oidcAccessToken);
    }

    return reply.code(201).send(fleet);
  });

  // GET /api/fleet/discover — find active fleet session for a character's current EVE fleet
  fastify.get('/api/fleet/discover', { preHandler: requireAuth }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    const { characterId } = q;
    if (!characterId) return reply.code(400).send({ error: 'characterId is required' });

    if (!req.session.userId) return reply.code(401).send({ error: 'Unauthorized' });
    const owned = await characterBelongsToUser(req.session.userId, Number(characterId));
    if (!owned) return reply.code(403).send({ error: 'Character not owned by you' });

    try {
      const token    = await exchangeEveToken(Number(characterId), req.session);
      const esiFleet = await getFleetForCharacter(token, Number(characterId));
      const { rows } = await query(
        'SELECT * FROM fleet_sessions WHERE eve_fleet_id = $1 AND is_open = TRUE LIMIT 1',
        [esiFleet.fleet_id],
      );
      if (!rows.length) return reply.code(404).send({ error: 'No active fleet session found' });
      return reply.send(rows[0]);
    } catch {
      return reply.code(404).send({ error: 'Not in a fleet' });
    }
  });

  // GET /api/fleet/my — all fleet sessions created by this FC
  fastify.get('/api/fleet/my', { preHandler: requireRole(ROLES.FC) }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    const { characterId } = q;
    if (!characterId) return reply.code(400).send({ error: 'characterId is required' });
    if (!req.session.userId) return reply.code(401).send({ error: 'Unauthorized' });
    const owned = await characterBelongsToUser(req.session.userId, Number(characterId));
    if (!owned) return reply.code(403).send({ error: 'Character not owned by you' });
    return reply.send(await fleets.getFleetsByFc(Number(characterId)));
  });

  // POST /api/fleet/:id/join
  fastify.post('/api/fleet/:id/join', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Record<string, unknown> | null;
    const { characterId } = body ?? {};
    if (!characterId) return reply.code(400).send({ error: 'characterId is required' });
    if (!req.session.userId) return reply.code(401).send({ error: 'Unauthorized' });
    const owned = await characterBelongsToUser(req.session.userId, characterId as number);
    if (!owned) return reply.code(403).send({ error: 'Character not owned by you' });
    const params = req.params as { id: string };
    const fleet = await fleets.getFleetById(params.id);
    if (!fleet || !fleet.is_open) return reply.code(404).send({ error: 'Fleet not found' });
    await upsertFleetMember(params.id, characterId as number);
    return reply.send({ ok: true });
  });

  // GET /api/fleet/:id/snapshot — live aggregate + presence snapshot
  fastify.get('/api/fleet/:id/snapshot', { preHandler: requireAuth }, async (req, reply) => {
    const params = req.params as { id: string };
    const fleet = await fleets.getFleetById(params.id);
    if (!fleet) return reply.code(404).send({ error: 'Fleet not found' });

    const [agg, presence] = await Promise.all([
      snapshotStore.getFleetAggregate(params.id),
      getFleetSystemSnapshot(params.id),
    ]);

    return reply.send({ aggregate: agg, presence });
  });

  // DELETE /api/fleet/:id — close fleet
  fastify.delete('/api/fleet/:id', { preHandler: requireRole(ROLES.FC) }, async (req, reply) => {
    const params = req.params as { id: string };
    const fleet = await fleets.getFleetById(params.id);
    if (!fleet) return reply.code(404).send({ error: 'Fleet not found' });

    if (!req.session.userId) return reply.code(401).send({ error: 'Unauthorized' });
    const owned = await characterBelongsToUser(req.session.userId, fleet.fc_character_id);
    if (!owned) return reply.code(403).send({ error: 'Not your fleet' });

    await fleets.closeFleet(params.id);
    stopTracking(params.id);
    return reply.send({ ok: true });
  });
}
