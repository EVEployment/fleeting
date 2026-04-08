import 'dotenv/config';
import './types/session.js';

import Fastify from 'fastify';
import fastifySession from '@fastify/session';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import ConnectPgSimple from 'connect-pg-simple';
import expressSession from 'express-session';
import { pool } from './db/pg.js';

import authRoutes    from './routes/auth.js';
import pilotRoutes   from './routes/pilot.js';
import fleetRoutes   from './routes/fleet.js';
import warRoutes     from './routes/war.js';
import historyRoutes from './routes/history.js';

import { startRetentionJob } from './lib/retentionJob.js';
import { resumeOpenFleets }  from './lib/memberTracker.js';
import { registry }          from './lib/metrics.js';
import { loadRateLimitGroups } from './lib/esiRateLimiter.js';

// trustProxy: 1 trusts exactly one hop (the immediate reverse-proxy, e.g. Nginx).
// Using `true` would trust any X-Forwarded-For header, enabling IP spoofing that
// could bypass rate limiting. Set to the actual proxy IP string in production if needed.
const app = Fastify({ logger: true, trustProxy: 1 });

const PgSessionStore = ConnectPgSimple(expressSession);
const pgStore = new PgSessionStore({ pool, tableName: 'sessions' });

async function start() {
  await app.register(fastifyCookie);

  await app.register(fastifySession, {
    secret: process.env.SESSION_SECRET!,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure:   process.env.NODE_ENV === 'production',
      maxAge:   parseInt(process.env.SESSION_MAX_AGE_MS ?? '604800000', 10),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: pgStore as any,
    saveUninitialized: false,
  });

  await app.register(fastifyCors, {
    origin:      false,
    credentials: true,
  });

  await app.register(fastifyRateLimit, {
    global:     true,
    max:        parseInt(process.env.RATE_LIMIT_MAX    ?? '1000',     10),
    timeWindow: process.env.RATE_LIMIT_WINDOW          ?? '1 minute',
  });

  await app.register(authRoutes);
  await app.register(pilotRoutes);
  await app.register(fleetRoutes);
  await app.register(warRoutes);
  await app.register(historyRoutes);

  // Health check — returns 200 once the server is fully started and DB is reachable.
  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return reply.send({ ok: true });
    } catch {
      return reply.status(503).send({ ok: false, reason: 'db_unavailable' });
    }
  });

  // Prometheus metrics endpoint — no auth; restrict via nginx/firewall in prod.
  app.get('/metrics', async (_req, reply) => {
    reply
      .header('Content-Type', registry.contentType)
      .send(await registry.metrics());
  });

  startRetentionJob();
  await resumeOpenFleets();

  // Fetch ESI OpenAPI spec to populate per-group rate-limit token buckets.
  // Errors here are non-fatal (rate-limit tracking will be a no-op until resolved).
  await loadRateLimitGroups().catch((err: unknown) =>
    console.warn('[startup] ESI OpenAPI spec load failed — rate-limit throttling disabled:', (err as Error).message),
  );

  await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });
}

async function shutdown(signal: string) {
  console.info(`[server] ${signal} received — shutting down gracefully`);
  try {
    await app.close();
    await pool.end();
    console.info('[server] Shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('[server] Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
