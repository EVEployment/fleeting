/**
 * server/lib/historyWriter.ts
 *
 * Called on every POST /api/pilot/data.
 * Three parallel write paths:
 *   A — Raw events: bulk-insert breakdown[] into combat_events
 *   B — 5s snapshot: write pilot_snapshots row (throttled per pilot)
 *   C — 30s timeline: upsert pilot_timeline bucket (throttled per pilot)
 */

import * as mem from '../store/memcached.js';
import * as events from '../db/queries/events.js';
import * as snapshots from '../db/queries/snapshots.js';
import * as timeline from '../db/queries/timeline.js';

const SNAPSHOT_INTERVAL_S = 5;
const TIMELINE_INTERVAL_S = 30;

function snapshotKey(charId: number) { return `hw:snap:${charId}`; }
function timelineKey(charId: number) { return `hw:tl:${charId}`; }
function tlBufKey(charId: number)    { return `hw:tlbuf:${charId}`; }

interface BreakdownEntry {
  pilotName?: string | null;
  targetName?: string | null;
  weaponType?: string | null;
  shipType?: string | null;
  category: string;
  amount: number;
  hitQuality?: string | null;
  occurredAt?: string | null;
}

interface PilotSnapshot {
  dpsOut: number;
  dpsIn: number;
  logiOut: number;
  logiIn: number;
  /** note: intentional typo preserved from original protocol */
  capTransfered: number;
  /** note: intentional typo preserved from original protocol */
  capRecieved: number;
  capDamageOut: number;
  capDamageIn: number;
  mined: number;
  percentiles?: {
    p50: number; p90: number; p95: number; p99: number; avg: number; median: number;
  };
  hitQualityDistribution?: Record<string, number>;
  breakdown?: BreakdownEntry[];
}

interface TlBuffer {
  count: number;
  dpsOut: number;
  dpsIn: number;
  logiOut: number;
  logiIn: number;
  capTransferred: number;
  capReceived: number;
  capDamageOut: number;
  capDamageIn: number;
  mined: number;
  maxDpsOut: number;
}

export async function write({
  fleetSessionId,
  characterId,
  snapshot,
  shipTypeId,
  solarSystemId,
}: {
  fleetSessionId: string;
  characterId: number;
  snapshot: PilotSnapshot;
  shipTypeId?: number;
  solarSystemId?: number;
}) {
  const now = new Date();

  // ── Path A: Raw events ─────────────────────────────────────────────────────
  if (snapshot.breakdown?.length) {
    const eventRows = snapshot.breakdown.map((b) => ({
      fleetSessionId,
      sourceCharacterId: characterId,
      targetName:  b.targetName ?? null,
      weaponType:  b.weaponType ?? null,
      shipType:    b.shipType ?? null,
      category:    b.category,
      amount:      b.amount,
      hitQuality:  b.hitQuality ?? null,
      occurredAt:  b.occurredAt ?? now.toISOString(),
    }));
    events.insertBatch(eventRows).catch((err: Error) =>
      console.error('[historyWriter] Event insert error:', err.message),
    );
  }

  // ── Path B: 5s pilot snapshot ─────────────────────────────────────────────
  const lastSnapTs = await mem.get<number>(snapshotKey(characterId));
  if (!lastSnapTs || now.getTime() - lastSnapTs >= SNAPSHOT_INTERVAL_S * 1000) {
    await mem.set(snapshotKey(characterId), now.getTime(), SNAPSHOT_INTERVAL_S * 4);
    const p = snapshot.percentiles ?? { p50: 0, p90: 0, p95: 0, p99: 0, avg: 0, median: 0 };
    snapshots.insert({
      fleetSessionId,
      characterId,
      recordedAt:     now,
      dpsOut:         snapshot.dpsOut,
      dpsIn:          snapshot.dpsIn,
      logiOut:        snapshot.logiOut,
      logiIn:         snapshot.logiIn,
      capTransferred: snapshot.capTransfered,
      capReceived:    snapshot.capRecieved,
      capDamageOut:   snapshot.capDamageOut,
      capDamageIn:    snapshot.capDamageIn,
      mined:          snapshot.mined,
      dmgOutP50:      p.p50,
      dmgOutP90:      p.p90,
      dmgOutP95:      p.p95,
      dmgOutP99:      p.p99,
      dmgOutAvg:      p.avg,
      dmgOutMedian:   p.median,
      hitQualityDist: snapshot.hitQualityDistribution,
      shipTypeId,
      solarSystemId,
    }).catch((err: Error) =>
      console.error('[historyWriter] Snapshot insert error:', err.message),
    );
  }

  // ── Path C: 30s timeline bucket ───────────────────────────────────────────
  const lastTlTs = await mem.get<number>(timelineKey(characterId));
  const bucketAt = bucketTimestamp(now, TIMELINE_INTERVAL_S);

  const buf: TlBuffer = (await mem.get<TlBuffer>(tlBufKey(characterId))) ?? {
    count: 0, dpsOut: 0, dpsIn: 0, logiOut: 0, logiIn: 0,
    capTransferred: 0, capReceived: 0, capDamageOut: 0, capDamageIn: 0,
    mined: 0, maxDpsOut: 0,
  };

  buf.count++;
  buf.dpsOut         = (buf.dpsOut         * (buf.count - 1) + snapshot.dpsOut)         / buf.count;
  buf.dpsIn          = (buf.dpsIn          * (buf.count - 1) + snapshot.dpsIn)          / buf.count;
  buf.logiOut        = (buf.logiOut        * (buf.count - 1) + snapshot.logiOut)        / buf.count;
  buf.logiIn         = (buf.logiIn         * (buf.count - 1) + snapshot.logiIn)         / buf.count;
  buf.capTransferred = (buf.capTransferred * (buf.count - 1) + snapshot.capTransfered)  / buf.count;
  buf.capReceived    = (buf.capReceived    * (buf.count - 1) + snapshot.capRecieved)    / buf.count;
  buf.capDamageOut   = (buf.capDamageOut   * (buf.count - 1) + snapshot.capDamageOut)   / buf.count;
  buf.capDamageIn    = (buf.capDamageIn    * (buf.count - 1) + snapshot.capDamageIn)    / buf.count;
  buf.mined          = (buf.mined          * (buf.count - 1) + snapshot.mined)          / buf.count;
  buf.maxDpsOut      = Math.max(buf.maxDpsOut, snapshot.dpsOut);

  await mem.set(tlBufKey(characterId), buf, TIMELINE_INTERVAL_S * 4);

  if (!lastTlTs || now.getTime() - lastTlTs >= TIMELINE_INTERVAL_S * 1000) {
    await mem.set(timelineKey(characterId), now.getTime(), TIMELINE_INTERVAL_S * 4);
    timeline.upsert({
      fleetSessionId,
      characterId,
      bucketAt,
      avgDpsOut:         buf.dpsOut,
      maxDpsOut:         buf.maxDpsOut,
      avgDpsIn:          buf.dpsIn,
      avgLogiOut:        buf.logiOut,
      avgLogiIn:         buf.logiIn,
      avgCapTransferred: buf.capTransferred,
      avgCapReceived:    buf.capReceived,
      avgCapDamageOut:   buf.capDamageOut,
      avgCapDamageIn:    buf.capDamageIn,
      avgMined:          buf.mined,
      hitQualityDist:    snapshot.hitQualityDistribution,
    }).catch((err: Error) =>
      console.error('[historyWriter] Timeline upsert error:', err.message),
    );
    await mem.del(tlBufKey(characterId));
  }
}

/** Floor a Date to the nearest N-second boundary. */
function bucketTimestamp(date: Date, intervalSeconds: number): Date {
  const ms = date.getTime();
  const bucketMs = Math.floor(ms / (intervalSeconds * 1000)) * intervalSeconds * 1000;
  return new Date(bucketMs);
}
