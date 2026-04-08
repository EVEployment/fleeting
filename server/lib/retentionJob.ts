/**
 * server/lib/retentionJob.ts
 *
 * Daily scheduled job that prunes combat_events partitions and pilot_snapshots
 * according to retention_config.
 */

import { query } from '../db/pg.js';

const MS_PER_DAY               = 86_400_000;
const RETENTION_STARTUP_DELAY_MS = parseInt(process.env.RETENTION_STARTUP_DELAY_MS ?? '60000',    10);
const RETENTION_INTERVAL_MS      = parseInt(process.env.RETENTION_INTERVAL_MS      ?? '86400000', 10);

interface RetentionConfig {
  fleet_session_id: string | null;
  raw_events_ttl_days: number | null;
  snapshots_ttl_days: number | null;
  timeline_ttl_days: number | null;
}

export async function runRetention() {
  console.info('[retention] Running retention job...');

  const { rows: configs } = await query<RetentionConfig>(
    `SELECT fleet_session_id, raw_events_ttl_days, snapshots_ttl_days, timeline_ttl_days
       FROM retention_config
      ORDER BY fleet_session_id NULLS LAST`,
  );

  const global: RetentionConfig = configs.find((c) => c.fleet_session_id === null) ?? {
    fleet_session_id:    null,
    raw_events_ttl_days: 30,
    snapshots_ttl_days:  90,
    timeline_ttl_days:   null,
  };

  // ── Prune pilot_snapshots ─────────────────────────────────────────────────
  if (global.snapshots_ttl_days != null) {
    const cutoff = new Date(Date.now() - global.snapshots_ttl_days * MS_PER_DAY);
    const { rowCount } = await query(
      `DELETE FROM pilot_snapshots WHERE recorded_at < $1`,
      [cutoff],
    );
    console.info(`[retention] Deleted ${rowCount} pilot_snapshots rows older than ${global.snapshots_ttl_days}d`);
  }

  // ── Prune pilot_timeline ──────────────────────────────────────────────────
  if (global.timeline_ttl_days != null) {
    const cutoff = new Date(Date.now() - global.timeline_ttl_days * MS_PER_DAY);
    const { rowCount } = await query(
      `DELETE FROM pilot_timeline WHERE bucket_at < $1`,
      [cutoff],
    );
    console.info(`[retention] Deleted ${rowCount} pilot_timeline rows older than ${global.timeline_ttl_days}d`);
  }

  // ── Drop expired combat_events partitions ─────────────────────────────────
  if (global.raw_events_ttl_days != null) {
    const cutoff = new Date(Date.now() - global.raw_events_ttl_days * MS_PER_DAY);
    const { rows: expiredFleets } = await query<{ id: string }>(
      `SELECT id FROM fleet_sessions WHERE closed_at IS NOT NULL AND closed_at < $1`,
      [cutoff],
    );

    /** Strict UUID v4 pattern — prevents SQL identifier injection */
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    for (const { id } of expiredFleets) {
      if (!UUID_RE.test(id)) {
        console.warn(`[retention] Skipping fleet id with unexpected format: ${id}`);
        continue;
      }
      const safeName = id.replace(/-/g, '_');
      const partitionName = `combat_events_${safeName}`;

      const { rows: exists } = await query(
        `SELECT 1 FROM pg_class WHERE relname = $1`,
        [partitionName],
      );
      if (exists.length) {
        await query(`DROP TABLE ${partitionName}`);
        console.info(`[retention] Dropped partition ${partitionName}`);
      }
    }
  }

  // ── Prune stale rows from the default partition ──────────────────────────
  if (global.raw_events_ttl_days != null) {
    const defaultCutoff = new Date(Date.now() - global.raw_events_ttl_days * MS_PER_DAY);
    const { rowCount } = await query(
      `DELETE FROM combat_events_default WHERE occurred_at < $1`,
      [defaultCutoff],
    );
    if (rowCount && rowCount > 0) {
      console.info(`[retention] Deleted ${rowCount} stale rows from combat_events_default`);
    }
  }

  console.info('[retention] Done.');
}

export function startRetentionJob() {
  setTimeout(() => {
    runRetention().catch(console.error);
    setInterval(() => runRetention().catch(console.error), RETENTION_INTERVAL_MS);
  }, RETENTION_STARTUP_DELAY_MS);
}
