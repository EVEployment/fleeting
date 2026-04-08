import type { FastifyInstance } from 'fastify';
import { oidcLogin, oidcCallback, requireAuth } from '../lib/auth.js';
import { query } from '../db/pg.js';

/** Validate fleet session ID format — UUID v4 only, prevents SQL injection. */
const FLEET_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function authRoutes(fastify: FastifyInstance) {
  // GET /auth/login — redirect to OIDC provider
  fastify.get('/auth/login', oidcLogin);

  // GET /auth/callback — OIDC redirect URI
  fastify.get('/auth/callback', oidcCallback);

  // POST /auth/logout — destroy session
  fastify.post('/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    await req.session.destroy();
    return reply.send({ ok: true });
  });

  // GET /api/me — current session info
  fastify.get('/api/me', { preHandler: requireAuth }, async (req, reply) => {
    return reply.send({
      userId:     req.session.userId,
      roles:      req.session.roles      ?? [],
      characters: req.session.characters ?? [],
    });
  });

  // GET /api/nchan/auth — Nchan authorize_request callback
  // Enforces per-fleet access: war_commanders may subscribe to any fleet;
  // other users may only subscribe to fleets they are a member or FC of.
  fastify.get('/api/nchan/auth', async (req, reply) => {
    if (!req.session.userId) return reply.code(403).send('Forbidden');

    // Nchan forwards the original subscriber URI via X-Original-URI, e.g.:
    //   /sub/fleet/uuid1,uuid2
    const originalUri = (req.headers['x-original-uri'] ?? '') as string;
    const match = /^\/sub\/fleet\/(.+)$/.exec(originalUri);
    if (!match) return reply.code(403).send('Invalid subscriber path');

    const rawIds  = match[1].split(',').map((id) => id.trim()).filter(Boolean);
    const fleetIds = rawIds.filter((id) => FLEET_UUID_RE.test(id));

    // Reject if any ID fails UUID validation (unknown format snuck in)
    if (fleetIds.length !== rawIds.length || fleetIds.length === 0) {
      return reply.code(403).send('Invalid fleet ID format');
    }

    // War commanders may observe any fleet
    const roles = req.session.roles ?? [];
    if (roles.includes('war_commander')) return reply.code(200).send('OK');

    // For FC / pilot: verify each requested fleet ID is accessible to this user.
    // A fleet is accessible when the user's character is either the FC or a fleet member.
    const characters = req.session.characters ?? [];
    const charIds    = characters.map((c) => c.id);

    if (charIds.length === 0) return reply.code(403).send('Forbidden');

    // Single query: return all fleet IDs from the list that this user can access
    const { rows } = await query<{ id: string }>(
      `SELECT fs.id
         FROM fleet_sessions fs
        WHERE fs.id = ANY($1)
          AND fs.is_open = TRUE
          AND (
            fs.fc_character_id = ANY($2)
            OR EXISTS (
              SELECT 1 FROM fleet_members fm
               WHERE fm.fleet_session_id = fs.id
                 AND fm.character_id     = ANY($2)
            )
          )`,
      [fleetIds, charIds],
    );

    const accessible = new Set(rows.map((r) => r.id));
    const allAllowed = fleetIds.every((id) => accessible.has(id));

    return allAllowed ? reply.code(200).send('OK') : reply.code(403).send('Forbidden');
  });
}
