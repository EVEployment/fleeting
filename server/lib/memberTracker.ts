/**
 * server/lib/memberTracker.ts
 *
 * Polls ESI every 30s for fleet member location + ship type, writes to member_presence.
 * One interval per open fleet session.
 *
 * NOTE: This module runs on timers without a request context.
 * `startTracking` accepts the FC's OIDC access token captured at fleet-start time.
 * If that token expires before the fleet ends, polling will fail on the passthrough
 * call and the tracker will stop. A future improvement would store the token in DB
 * and refresh it headlessly (see backlog in refactor-plan.md).
 */

import type { FastifyRequest } from 'fastify';
import { exchangeEveToken } from './auth.js';
import { getFleetMembers } from './esi.js';
import { insertPresenceBatch, touchFleetMembers } from '../db/queries/members.js';
import * as mem from '../store/memcached.js';
import { getOpenFleets } from '../db/queries/fleets.js';
import { activeFleetTrackers, fleetTrackerPollsTotal } from './metrics.js';

const POLL_INTERVAL_MS = parseInt(process.env.MEMBER_POLL_INTERVAL_MS ?? '30000', 10);

interface TrackerEntry {
  timer: ReturnType<typeof setInterval>;
  fcCharacterId: number;
  eveFleetId: bigint;
  oidcAccessToken: string;
}

/** Map<fleetSessionId, TrackerEntry> */
const activeTrackers = new Map<string, TrackerEntry>();

/**
 * Start tracking a fleet session.
 * @param oidcAccessToken - The FC's current in-house OIDC access token (captured at fleet-start).
 */
export function startTracking(
  fleetSessionId: string,
  fcCharacterId: number,
  eveFleetId: bigint,
  oidcAccessToken: string,
) {
  if (activeTrackers.has(fleetSessionId)) return;

  const timer = setInterval(
    () => poll(fleetSessionId, fcCharacterId, eveFleetId, oidcAccessToken),
    POLL_INTERVAL_MS,
  );

  activeTrackers.set(fleetSessionId, { timer, fcCharacterId, eveFleetId, oidcAccessToken });
  activeFleetTrackers.set(activeTrackers.size);

  // Immediate first poll
  poll(fleetSessionId, fcCharacterId, eveFleetId, oidcAccessToken).catch(console.error);
}

/** Stop tracking a fleet session (data is retained in DB). */
export function stopTracking(fleetSessionId: string) {
  const tracker = activeTrackers.get(fleetSessionId);
  if (!tracker) return;
  clearInterval(tracker.timer);
  activeTrackers.delete(fleetSessionId);
  activeFleetTrackers.set(activeTrackers.size);
}

async function poll(
  fleetSessionId: string,
  fcCharacterId: number,
  eveFleetId: bigint,
  oidcAccessToken: string,
) {
  try {
    // Build a minimal session-like object so exchangeEveToken can call passthrough.
    // oidcRefreshToken is intentionally empty — if the OIDC token expires, the
    // passthrough call will return 401 and we catch + stop the tracker below.
    const sessionProxy = {
      oidcAccessToken,
      oidcRefreshToken: '',
      oidcAccessExpiry: Date.now() + 24 * 3600_000, // suppress premature refresh attempts
    } as unknown as FastifyRequest['session'];

    const token = await exchangeEveToken(fcCharacterId, sessionProxy);
    const members = await getFleetMembers(token, eveFleetId);

    const records = members.map((m: { character_id: number; solar_system_id: number; ship_type_id: number }) => ({
      fleetSessionId,
      characterId: m.character_id,
      solarSystemId: m.solar_system_id,
      shipTypeId: m.ship_type_id,
    }));

    await insertPresenceBatch(records);
    await touchFleetMembers(fleetSessionId, members.map((m: { character_id: number }) => m.character_id));
    // Update presence cache so pilot.ts POST handler can enrich snapshots without DB queries
    for (const r of records) {
      mem.set(`presence:${fleetSessionId}:${r.characterId}`, {
        shipTypeId: r.shipTypeId, solarSystemId: r.solarSystemId,
      }, 60).catch(() => {});
    }
    fleetTrackerPollsTotal.inc({ result: 'success' });
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    fleetTrackerPollsTotal.inc({ result: 'error' });
    if (status === 404) {
      console.warn(`[memberTracker] Fleet ${fleetSessionId} not found on ESI — stopping tracker`);
      stopTracking(fleetSessionId);
    } else if (status === 401 || status === 403) {
      console.warn(`[memberTracker] Auth failed (${status}) for fleet ${fleetSessionId} — stopping tracker. FC must re-open fleet to resume.`);
      stopTracking(fleetSessionId);
    } else {
      console.error(
        `[memberTracker] Poll error for fleet ${fleetSessionId}:`,
        (err as Error).message,
      );
    }
  }
}

/**
 * On server restart: re-register timers for all open fleet sessions.
 * NOTE: After restart the OIDC access token is no longer in memory.
 * Trackers will fail on the first passthrough call and self-stop.
 * FCs must close and re-open fleets after a server restart.
 */
export async function resumeOpenFleets() {
  const fleets = await getOpenFleets();
  for (const fleet of fleets) {
    if (fleet.eve_fleet_id) {
      // No stored OIDC token available after restart — tracking will gracefully fail.
      startTracking(fleet.id, fleet.fc_character_id, BigInt(fleet.eve_fleet_id), '');
    }
  }
  console.info(`[memberTracker] Resumed tracking for ${fleets.length} open fleet(s)`);
}
