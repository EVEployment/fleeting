import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../lib/auth.js';
import { characterBelongsToUser } from '../db/queries/users.js';
import { upsertFleetMember, getLatestPresence } from '../db/queries/members.js';
import * as mem from '../store/memcached.js';
import * as snapshotStore from '../store/snapshotStore.js';
import type { PilotSnapshot } from '../lib/aggregate.js';
import { publish } from '../lib/nchanPublisher.js';
import { write } from '../lib/historyWriter.js';
import { exchangeEveToken } from '../lib/auth.js';
import { getCharacterOnlineStatus } from '../lib/esi.js';

/** Numeric fields expected in the snapshot that must be finite numbers. */
const NUMERIC_SNAPSHOT_FIELDS = [
  'dpsOut', 'dpsIn', 'logiOut', 'logiIn',
  'capTransfered', 'capRecieved', 'capDamageOut', 'capDamageIn', 'mined',
] as const;

/** Returns true when value is a finite number (rejects NaN, Infinity, non-numbers). */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Validate and sanitize the numeric fields of an incoming snapshot. */
function sanitizeSnapshot(raw: Record<string, unknown>): PilotSnapshot {
  const out: Record<string, unknown> = {};
  for (const field of NUMERIC_SNAPSHOT_FIELDS) {
    const v = raw[field];
    out[field] = isFiniteNumber(v) ? v : 0;
  }
  // Pass through safe non-numeric fields
  if (raw['hitQualityDistribution'] !== undefined) out['hitQualityDistribution'] = raw['hitQualityDistribution'];
  if (raw['hitQualityDistributionIn'] !== undefined) out['hitQualityDistributionIn'] = raw['hitQualityDistributionIn'];
  if (raw['percentiles'] !== undefined) out['percentiles'] = raw['percentiles'];
  if (Array.isArray(raw['breakdown'])) out['breakdown'] = raw['breakdown'];
  // Identity & metadata — required for aggregate memberSnapshots keying and role classification
  if (isFiniteNumber(raw['characterId']))   out['characterId']   = raw['characterId'];
  if (isFiniteNumber(raw['shipTypeId']))    out['shipTypeId']    = raw['shipTypeId'];
  if (isFiniteNumber(raw['solarSystemId'])) out['solarSystemId'] = raw['solarSystemId'];
  return out as unknown as PilotSnapshot;
}

export default async function pilotRoutes(fastify: FastifyInstance) {
  // GET /api/character/:id/online — proxy ESI online status for the character
  fastify.get('/api/character/:id/online', { preHandler: requireAuth }, async (req, reply) => {
    const params = req.params as { id: string };
    const characterId = Number(params.id);
    if (!Number.isInteger(characterId) || characterId <= 0) {
      return reply.code(400).send({ error: 'Invalid characterId' });
    }
    if (!req.session.userId) return reply.code(401).send({ error: 'Unauthorized' });
    const owned = await characterBelongsToUser(req.session.userId, characterId);
    if (!owned) return reply.code(403).send({ error: 'Character does not belong to your account' });
    try {
      const token  = await exchangeEveToken(characterId, req.session);
      const status = await getCharacterOnlineStatus(token, characterId);
      return reply.send({ online: status.online });
    } catch {
      // If ESI fails we conservatively report offline so fleet ops are skipped.
      return reply.send({ online: false });
    }
  });

  fastify.post('/api/pilot/data', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Record<string, unknown> | null;
    const { characterId, fleetSessionId, snapshot } = body ?? {};

    if (!characterId || !snapshot) {
      return reply.code(400).send({ error: 'characterId and snapshot are required' });
    }

    if (!req.session.userId) return reply.code(401).send({ error: 'Unauthorized' });
    const owned = await characterBelongsToUser(req.session.userId, characterId as number);
    if (!owned) {
      return reply.code(403).send({ error: 'Character does not belong to your account' });
    }

    const snap: PilotSnapshot = sanitizeSnapshot({
      ...(snapshot as Record<string, unknown>),
      characterId: characterId as number,
    });

    if (fleetSessionId) {
      // Enrich snapshot with ESI-sourced metadata (ship type, location) if not already present.
      // memberTracker writes this to member_presence every 30s; we cache in Memcached to avoid
      // querying DB on every 2s POST.
      if (snap.shipTypeId == null) {
        const presenceKey = `presence:${fleetSessionId}:${characterId}`;
        let cached = await mem.get<{ shipTypeId: number; solarSystemId: number }>(presenceKey);
        if (!cached) {
          cached = (await getLatestPresence(fleetSessionId as string, characterId as number)) ?? null;
          if (cached) await mem.set(presenceKey, cached, 60);
        }
        if (cached) {
          snap.shipTypeId = cached.shipTypeId;
          snap.solarSystemId = cached.solarSystemId;
        }
      }

      await snapshotStore.setPilotSnapshot(fleetSessionId as string, characterId as number, snap);
      await snapshotStore.addFleetMember(fleetSessionId as string, characterId as number);
      // Record DB membership immediately so nchan auth can verify access without waiting for
      // the ESI member-tracker poll (which runs every 30 s).
      upsertFleetMember(fleetSessionId as string, characterId as number).catch(console.error);

      const fleetAgg = await snapshotStore.getFleetAggregate(fleetSessionId as string);
      if (fleetAgg) {
        publish(fleetSessionId as string, { ...fleetAgg, fleetSessionId }).catch(console.error);
      }

      write({
        fleetSessionId: fleetSessionId as string,
        characterId: characterId as number,
        snapshot: snapshot as Parameters<typeof write>[0]['snapshot'],
        shipTypeId: snap.shipTypeId,
        solarSystemId: snap.solarSystemId,
      }).catch(console.error);
    }

    return reply.code(204).send();
  });
}
