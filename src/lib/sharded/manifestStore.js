// Each live demo's Pages manifest is a local file committed to this repo,
// `state/manifests/<shard>/<slug>.json`; D1 keeps only its fingerprint (and
// file count, deployed_at) in `demo_placements`, so a deploy writes ~2 D1 rows
// instead of one per file. A file is written only after its deploy is live.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ShardStateMismatchError } from '../../errors.js';
import { slugPrefix } from './manifest.js';

const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
export const DEFAULT_MANIFESTS_DIR = join(PACKAGE_ROOT, 'state', 'manifests');

/** sha256 over the sorted `path\thash` lines: independent of key order and JSON formatting. */
export function fingerprintOf(files) {
  const lines = Object.entries(files)
    .map(([path, hash]) => `${path}\t${hash}`)
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export function manifestFilePath(dir, shard, slug) {
  return join(dir, shard, `${slug}.json`);
}

export function toManifestRecord({ slug, shard, leadId = null, files, deployedAt, deploymentUrl = null }) {
  return { slug, shard, leadId, fileCount: Object.keys(files).length, fingerprint: fingerprintOf(files), deployedAt, deploymentUrl, files };
}

export function readManifestRecord(dir, shard, slug) {
  const path = manifestFilePath(dir, shard, slug);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Temp file + rename, so a crash never leaves a half-written manifest. */
export function writeManifestRecord(dir, record) {
  const path = manifestFilePath(dir, record.shard, record.slug);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temp, path);
  return path;
}

export function removeManifestRecord(dir, shard, slug) {
  rmSync(manifestFilePath(dir, shard, slug), { force: true });
}

/** Why the local manifest of a placed slug cannot be trusted, or null when it matches D1. */
export function manifestProblem(record, placement) {
  if (!record) return 'no local manifest';
  if (!placement.fingerprint) return 'no fingerprint in D1';
  const prefix = slugPrefix(placement.slug);
  if (!Object.keys(record.files).every((path) => path.startsWith(prefix))) return `paths outside ${prefix}`;
  const fingerprint = fingerprintOf(record.files);
  if (fingerprint !== record.fingerprint) return 'file edited (fingerprint does not match its files)';
  if (fingerprint !== placement.fingerprint) return 'fingerprint differs from D1';
  // A deploy that did not write this file (another machine, or pre-manifest code) still bumps updated_at.
  if (record.deployedAt !== placement.updated_at) return `deployed_at ${record.deployedAt} differs from D1 ${placement.updated_at}`;
  return null;
}

// D1 fingerprint of a slug a deploy left out (`skipStale`) of its shard: still placed (keeps its slot and
// file budget) but not served, so it is neither a neighbour to verify nor a reason to abort.
export const OFFLINE_FINGERPRINT = 'offline';

/**
 * The shard's manifest without `exceptSlug`, built from the local files of every
 * other live slug placed on it, plus every slug whose file is missing or stale
 * (`{slug, leadId, problem}`).
 */
export function collectShardManifest(dir, shard, placements, exceptSlug) {
  const manifest = {};
  const stale = [];
  for (const placement of placements) {
    if (placement.slug === exceptSlug || placement.fingerprint === OFFLINE_FINGERPRINT) continue;
    const record = readManifestRecord(dir, shard, placement.slug);
    const problem = manifestProblem(record, placement);
    if (problem) stale.push({ slug: placement.slug, leadId: placement.lead_id ?? null, problem });
    else Object.assign(manifest, record.files);
  }
  return { manifest, stale };
}

/**
 * Like collectShardManifest, but any missing or stale file aborts: deploying a
 * shard from incomplete state would silently drop another demo's files.
 */
export function loadShardManifest(dir, shard, placements, exceptSlug) {
  const { manifest, stale } = collectShardManifest(dir, shard, placements, exceptSlug);
  if (stale.length) throw new ShardStateMismatchError(shard, stale);
  return manifest;
}

/**
 * Best effort: commits the manifests dir of the repo it lives in (deletions
 * included). Failing to commit never fails a deploy that is already live; the
 * file on disk is what the next deploy verifies.
 */
export function commitManifests(dir, message) {
  try {
    const root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const pathspec = relative(root, dir).replaceAll('\\', '/');
    execFileSync('git', ['-C', root, 'add', '-A', '--', pathspec], { stdio: 'pipe' });
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', message, '--', pathspec], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
