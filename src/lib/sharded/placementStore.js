import { ShardLockLostError } from '../../errors.js';
import { OFFLINE_FINGERPRINT } from './manifestStore.js';

export async function getPlacement(db, slug) {
  const [row] = await db.query('SELECT slug, shard, lead_id, file_count FROM demo_placements WHERE slug = ?', [slug]);
  return row ?? null;
}

/** Shard name → files placed on it (from placements, so it reads one row per demo). */
export async function readShardLoads(db) {
  const rows = await db.query('SELECT shard, SUM(file_count) AS files FROM demo_placements GROUP BY shard');
  return Object.fromEntries(rows.map((row) => [row.shard, Number(row.files)]));
}

/** Every slug placed on the shard with the fingerprint and deploy time its local manifest must match. */
export function readShardPlacements(db, shard) {
  return db.query('SELECT slug, lead_id, fingerprint, file_count, updated_at FROM demo_placements WHERE shard = ? ORDER BY slug', [shard]);
}

function upsertPlacement({ shard, slug, leadId, fileCount, fingerprint, updatedAt }, guard) {
  return {
    sql: `INSERT INTO demo_placements (slug, shard, lead_id, file_count, fingerprint, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
      ON CONFLICT(slug) DO UPDATE SET shard = excluded.shard, lead_id = COALESCE(excluded.lead_id, demo_placements.lead_id),
      file_count = excluded.file_count, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
    params: [slug, shard, leadId ?? null, fileCount, fingerprint, updatedAt, ...guard.params],
  };
}

// The Worker proxies to this immutable deployment URL: the <shard>.pages.dev alias can keep serving a superseded deployment from cache.
function upsertShardDeployment({ shard, deploymentUrl, updatedAt }, guard) {
  return {
    sql: `INSERT INTO shard_deployments (shard, url, updated_at) SELECT ?, ?, ? WHERE ${guard.sql}
      ON CONFLICT(shard) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`,
    params: [shard, deploymentUrl, updatedAt, ...guard.params],
  };
}

// updated_at is left alone: it is the slug's last real deploy (factory's reconcile reads it as one).
function markOfflineStatements(lease, skipped) {
  return skipped.map(({ slug }) => ({
    sql: `UPDATE demo_placements SET fingerprint = ? WHERE slug = ? AND shard = ? AND ${lease.guard.sql}`,
    params: [OFFLINE_FINGERPRINT, slug, lease.shard, ...lease.guard.params],
  }));
}

/**
 * Placement (with the new manifest's fingerprint) + the shard's deployment URL: 2 rows, plus one per
 * stale slug the deployment left out (`skipped`); no-ops unless the lease is still ours.
 */
export function slugWriteStatements({ lease, record, skipped = [] }) {
  const { slug, leadId, fileCount, fingerprint, deployedAt: updatedAt, deploymentUrl } = record;
  return [
    upsertPlacement({ shard: lease.shard, slug, leadId, fileCount, fingerprint, updatedAt }, lease.guard),
    upsertShardDeployment({ shard: lease.shard, deploymentUrl, updatedAt }, lease.guard),
    ...markOfflineStatements(lease, skipped),
  ];
}

export function slugRemoveStatements({ lease, slug, deploymentUrl, updatedAt, skipped = [] }) {
  return [
    { sql: `DELETE FROM demo_placements WHERE slug = ? AND ${lease.guard.sql}`, params: [slug, ...lease.guard.params] },
    upsertShardDeployment({ shard: lease.shard, deploymentUrl, updatedAt }, lease.guard),
    ...markOfflineStatements(lease, skipped),
  ];
}

/**
 * Runs the statements as one D1 transaction and confirms, in that same
 * transaction, that the lease was still ours — i.e. that the guarded writes
 * actually landed rather than silently matching nothing.
 */
export async function commitUnderLease(db, lease, statements) {
  const results = await db.batch([...statements, { sql: 'SELECT holder FROM shard_locks WHERE shard = ?', params: [lease.shard] }]);
  if (results.at(-1)[0]?.holder !== lease.holder) throw new ShardLockLostError(lease.shard);
}
