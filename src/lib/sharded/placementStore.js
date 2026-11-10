import { ShardLockLostError } from '../../errors.js';
import { slugPrefix } from './manifest.js';

const MANIFEST_PAGE_ROWS = 5_000;
// D1 allows 100 bound parameters per statement: 1 shard + 2 per row + the 2-param lease guard.
const ROWS_PER_INSERT = 48;

export async function getPlacement(db, slug) {
  const [row] = await db.query('SELECT slug, shard, lead_id, file_count FROM demo_placements WHERE slug = ?', [slug]);
  return row ?? null;
}

/** Shard name → files placed on it (from placements, so it reads one row per demo). */
export async function readShardLoads(db) {
  const rows = await db.query('SELECT shard, SUM(file_count) AS files FROM demo_placements GROUP BY shard');
  return Object.fromEntries(rows.map((row) => [row.shard, Number(row.files)]));
}

/** The shard's current manifest `{path: hash}`, read in keyset pages. */
export async function readShardManifest(db, shard) {
  const manifest = {};
  let after = '';
  for (;;) {
    const rows = await db.query(
      'SELECT path, hash FROM demo_files WHERE shard = ? AND path > ? ORDER BY path LIMIT ?',
      [shard, after, MANIFEST_PAGE_ROWS],
    );
    for (const row of rows) manifest[row.path] = row.hash;
    if (rows.length < MANIFEST_PAGE_ROWS) return manifest;
    after = rows.at(-1).path;
  }
}

function deleteSlugFiles(shard, slug, guard) {
  const prefix = slugPrefix(slug);
  return {
    sql: `DELETE FROM demo_files WHERE shard = ? AND substr(path, 1, ?) = ? AND ${guard.sql}`,
    params: [shard, prefix.length, prefix, ...guard.params],
  };
}

function insertFiles(shard, entries, guard) {
  const values = entries.map(() => '(?, ?)').join(', ');
  return {
    sql: `INSERT INTO demo_files (shard, path, hash) SELECT ?, column1, column2 FROM (VALUES ${values}) WHERE ${guard.sql}`,
    params: [shard, ...entries.flat(), ...guard.params],
  };
}

function chunk(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}

function upsertPlacement({ shard, slug, leadId, fileCount, updatedAt }, guard) {
  return {
    sql: `INSERT INTO demo_placements (slug, shard, lead_id, file_count, updated_at) SELECT ?, ?, ?, ?, ? WHERE ${guard.sql}
      ON CONFLICT(slug) DO UPDATE SET shard = excluded.shard, lead_id = COALESCE(excluded.lead_id, demo_placements.lead_id),
      file_count = excluded.file_count, updated_at = excluded.updated_at`,
    params: [slug, shard, leadId ?? null, fileCount, updatedAt, ...guard.params],
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

/** Statements replacing the slug's manifest rows, placement and the shard's deployment URL; every one is a no-op unless the lease is still ours. */
export function slugWriteStatements({ lease, slug, leadId, slugManifest, deploymentUrl, updatedAt }) {
  const entries = Object.entries(slugManifest);
  return [
    deleteSlugFiles(lease.shard, slug, lease.guard),
    ...chunk(entries, ROWS_PER_INSERT).map((rows) => insertFiles(lease.shard, rows, lease.guard)),
    upsertPlacement({ shard: lease.shard, slug, leadId, fileCount: entries.length, updatedAt }, lease.guard),
    upsertShardDeployment({ shard: lease.shard, deploymentUrl, updatedAt }, lease.guard),
  ];
}

export function slugRemoveStatements({ lease, slug, deploymentUrl, updatedAt }) {
  return [
    deleteSlugFiles(lease.shard, slug, lease.guard),
    { sql: `DELETE FROM demo_placements WHERE slug = ? AND ${lease.guard.sql}`, params: [slug, ...lease.guard.params] },
    upsertShardDeployment({ shard: lease.shard, deploymentUrl, updatedAt }, lease.guard),
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
