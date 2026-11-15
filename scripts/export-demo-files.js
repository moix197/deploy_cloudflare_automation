// One-time migration (2026-11-15): turns D1 `demo_files` rows into the local
// per-slug manifest files (state/manifests/<shard>/<slug>.json) and records
// each one's fingerprint in `demo_placements`. Delete this script together
// with factory-cli's demo_files drop migration once the owner has verified.
//
//   node scripts/export-demo-files.js --d1-database <id>
//
// Placements are read before the files and each fingerprint update is guarded
// by the placement's updated_at, so a deploy racing the export leaves that
// slug without a fingerprint (its shard then refuses to deploy) instead of
// recording a manifest that is not live.
import { resolveAuth, resolveDemosDatabaseId } from '../src/auth/resolveAuth.js';
import { createD1Executor } from '../src/lib/sharded/d1.js';
import { commitManifests, DEFAULT_MANIFESTS_DIR, toManifestRecord, writeManifestRecord } from '../src/lib/sharded/manifestStore.js';

const PAGE_ROWS = 5_000;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function readShardFiles(db, shard) {
  const files = {};
  for (let after = ''; ;) {
    const rows = await db.query('SELECT path, hash FROM demo_files WHERE shard = ? AND path > ? ORDER BY path LIMIT ?', [shard, after, PAGE_ROWS]);
    for (const row of rows) files[row.path] = row.hash;
    if (rows.length < PAGE_ROWS) return files;
    after = rows.at(-1).path;
  }
}

function groupBySlug(files) {
  const groups = {};
  for (const [path, hash] of Object.entries(files)) {
    const slug = path.split('/')[1];
    (groups[slug] ??= {})[path] = hash;
  }
  return groups;
}

function toRecords(placements, deployments, filesByShard) {
  return placements.map((placement) => toManifestRecord({
    slug: placement.slug,
    shard: placement.shard,
    leadId: placement.lead_id,
    files: filesByShard[placement.shard][placement.slug] ?? {},
    deployedAt: placement.updated_at,
    deploymentUrl: deployments[placement.shard] ?? null,
  }));
}

function orphanSlugs(placements, filesByShard) {
  const placed = new Set(placements.map((p) => `${p.shard}/${p.slug}`));
  return Object.entries(filesByShard).flatMap(([shard, groups]) => Object.keys(groups).filter((slug) => !placed.has(`${shard}/${slug}`)).map((slug) => `${shard}/${slug}`));
}

async function main() {
  const db = createD1Executor({ ...resolveAuth(), databaseId: resolveDemosDatabaseId(argValue('--d1-database')) });
  const placements = await db.query('SELECT slug, shard, lead_id, file_count, updated_at FROM demo_placements ORDER BY shard, slug');
  const deployments = Object.fromEntries((await db.query('SELECT shard, url FROM shard_deployments')).map((row) => [row.shard, row.url]));
  const filesByShard = {};
  for (const shard of new Set(placements.map((p) => p.shard))) filesByShard[shard] = groupBySlug(await readShardFiles(db, shard));

  const records = toRecords(placements, deployments, filesByShard);
  for (const record of records) writeManifestRecord(DEFAULT_MANIFESTS_DIR, record);
  const results = await db.batch(records.map((record) => ({
    sql: 'UPDATE demo_placements SET fingerprint = ? WHERE slug = ? AND updated_at = ? RETURNING slug',
    params: [record.fingerprint, record.slug, record.deployedAt],
  })));
  const raced = records.filter((_, i) => results[i].length === 0).map((r) => r.slug);
  const countMismatch = records.filter((r, i) => r.fileCount !== placements[i].file_count).map((r) => `${r.slug} (${r.fileCount} files, placement says ${placements[i].file_count})`);
  const committed = commitManifests(DEFAULT_MANIFESTS_DIR, `Manifest: export ${records.length} live demos from D1 demo_files`);
  console.log(JSON.stringify({ exported: records.length, files: records.reduce((n, r) => n + r.fileCount, 0), raced, countMismatch, orphans: orphanSlugs(placements, filesByShard), committed }, null, 2));
}

await main();
