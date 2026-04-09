import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireRole } from '../lib/auth.js';
import { ROLES } from '../lib/roles.js';
import * as historyQueries from '../db/queries/history.js';
import * as events from '../db/queries/events.js';
import * as snapshots from '../db/queries/snapshots.js';
import * as timeline from '../db/queries/timeline.js';
import { getPresenceTimeline } from '../db/queries/members.js';
import { getFleetById } from '../db/queries/fleets.js';

function requireFCOrWar(req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) {
  const roles = req.session.roles;
  if (roles?.includes(ROLES.FC) || roles?.includes(ROLES.WAR_COMMANDER)) {
    return done();
  }
  reply.code(403).send({ error: 'Forbidden' });
}

export default async function historyRoutes(fastify: FastifyInstance) {
  // GET /api/history/fleets — paginated list (FC or war_commander)
  fastify.get('/api/history/fleets', { preHandler: requireFCOrWar }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const page  = Number(q['page']  ?? 1);
    const limit = Number(q['limit'] ?? 20);
    return reply.send(await historyQueries.getFleetList({ page, limit }));
  });

  // GET /api/history/fleet/:id/summary
  fastify.get('/api/history/fleet/:id/summary', { preHandler: requireFCOrWar }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const fleet = await getFleetById(id);
    if (!fleet) return reply.code(404).send({ error: 'Fleet not found' });
    return reply.send(await historyQueries.getFleetSummary(id));
  });

  // GET /api/history/fleet/:id/timeline
  fastify.get('/api/history/fleet/:id/timeline', { preHandler: requireFCOrWar }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const fleet = await getFleetById(id);
    if (!fleet) return reply.code(404).send({ error: 'Fleet not found' });
    return reply.send(await timeline.getForFleet(id));
  });

  // GET /api/history/fleet/:id/snapshots/:charId
  fastify.get('/api/history/fleet/:id/snapshots/:charId', { preHandler: requireFCOrWar }, async (req, reply) => {
    const { id, charId } = req.params as { id: string; charId: string };
    const fleet = await getFleetById(id);
    if (!fleet) return reply.code(404).send({ error: 'Fleet not found' });
    return reply.send(await snapshots.getForPilot(id, Number(charId)));
  });

  // GET /api/history/fleet/:id/peer-median/:charId — as-of peer median DPS for a pilot
  fastify.get('/api/history/fleet/:id/peer-median/:charId', { preHandler: requireFCOrWar }, async (req, reply) => {
    const { id, charId } = req.params as { id: string; charId: string };
    const fleet = await getFleetById(id);
    if (!fleet) return reply.code(404).send({ error: 'Fleet not found' });
    return reply.send(await snapshots.getPeerMedianForPilot(id, Number(charId)));
  });

  // GET /api/history/fleet/:id/snapshot-at?t=ISO — fleet state at a point in time (scrub)
  fastify.get('/api/history/fleet/:id/snapshot-at', { preHandler: requireFCOrWar }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const fleet = await getFleetById(id);
    if (!fleet) return reply.code(404).send({ error: 'Fleet not found' });
    const q = req.query as Record<string, string | undefined>;
    const t = q['t'];
    if (!t) return reply.code(400).send({ error: 'Missing t query param (ISO timestamp)' });
    const at = new Date(t);
    if (isNaN(at.getTime())) return reply.code(400).send({ error: 'Invalid timestamp' });
    return reply.send(await snapshots.getFleetSnapshotAt(id, at));
  });

  // GET /api/history/fleet/:id/presence
  fastify.get('/api/history/fleet/:id/presence', { preHandler: requireFCOrWar }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const fleet = await getFleetById(id);
    if (!fleet) return reply.code(404).send({ error: 'Fleet not found' });
    return reply.send(await getPresenceTimeline(id));
  });

  // GET /api/history/fleet/:id/events — paginated + filtered
  fastify.get('/api/history/fleet/:id/events', { preHandler: requireFCOrWar }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const fleet = await getFleetById(id);
    if (!fleet) return reply.code(404).send({ error: 'Fleet not found' });

    const q = req.query as Record<string, string | undefined>;
    const result = await events.search(
      id,
      {
        charId:     q['charId'] ? Number(q['charId']) : undefined,
        category:   q['category'],
        target:     q['target'],
        weapon:     q['weapon'],
        hitQuality: q['hitQuality'],
        from:       q['from'],
        to:         q['to'],
      },
      {
        page:  Number(q['page']  ?? 1),
        limit: Math.min(Number(q['limit'] ?? 100), 500),
      },
    );
    return reply.send(result);
  });

  // GET /api/history/fleet/:id/participation
  fastify.get('/api/history/fleet/:id/participation', { preHandler: requireFCOrWar }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const fleet = await getFleetById(id);
    if (!fleet) return reply.code(404).send({ error: 'Fleet not found' });
    return reply.send(await historyQueries.getFleetParticipation(id));
  });
}
