import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ShardStateMismatchError } from '../../errors.js';
import {
  fingerprintOf,
  loadShardManifest,
  manifestProblem,
  readManifestRecord,
  removeManifestRecord,
  toManifestRecord,
  writeManifestRecord,
} from './manifestStore.js';

const SHARD = 'wx-demos-01';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cfpd-store-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const record = (slug, files, deployedAt = '2026-11-15T00:00:00.000Z') => toManifestRecord({ slug, shard: SHARD, files, deployedAt });
const placementOf = (r) => ({ slug: r.slug, fingerprint: r.fingerprint, file_count: r.fileCount, updated_at: r.deployedAt });

test('fingerprint ignores key order and changes with any path or hash', () => {
  const base = fingerprintOf({ '/a/x.html': 'h1', '/a/y.css': 'h2' });
  assert.equal(fingerprintOf({ '/a/y.css': 'h2', '/a/x.html': 'h1' }), base);
  assert.notEqual(fingerprintOf({ '/a/x.html': 'h1', '/a/y.css': 'h3' }), base);
  assert.notEqual(fingerprintOf({ '/a/x.html': 'h1', '/a/z.css': 'h2' }), base);
  assert.match(base, /^[0-9a-f]{64}$/);
});

test('a written record reads back as-is, under <shard>/<slug>.json, with no temp file left', () =>
  withDir((dir) => {
    const r = record('alpha', { '/alpha/index.html': 'h' });
    assert.equal(writeManifestRecord(dir, r), join(dir, SHARD, 'alpha.json'));
    assert.deepEqual(readManifestRecord(dir, SHARD, 'alpha'), r);
    assert.deepEqual(readdirSync(join(dir, SHARD)), ['alpha.json']);
    assert.equal(r.fileCount, 1);
    removeManifestRecord(dir, SHARD, 'alpha');
    assert.equal(readManifestRecord(dir, SHARD, 'alpha'), null);
  }));

test('manifestProblem accepts only a file matching its own fingerprint and the D1 registry', () => {
  const r = record('alpha', { '/alpha/index.html': 'h' });
  const placement = placementOf(r);
  assert.equal(manifestProblem(r, placement), null);
  assert.equal(manifestProblem(null, placement), 'no local manifest');
  assert.equal(manifestProblem(r, { ...placement, fingerprint: null }), 'no fingerprint in D1');
  assert.equal(manifestProblem(r, { ...placement, fingerprint: 'f' }), 'fingerprint differs from D1');
  assert.match(manifestProblem({ ...r, files: { '/alpha/index.html': 'edited' } }, placement), /file edited/);
  assert.match(manifestProblem(r, { ...placement, updated_at: 'later' }), /deployed_at .* differs from D1 later/);
  const foreign = record('alpha', { '/beta/index.html': 'h' });
  assert.equal(manifestProblem(foreign, placementOf(foreign)), 'paths outside /alpha/');
});

test('loadShardManifest merges every other slug and skips the one being replaced', () =>
  withDir((dir) => {
    const alpha = record('alpha', { '/alpha/index.html': 'a' });
    const beta = record('beta', { '/beta/index.html': 'b', '/beta/x.css': 'c' });
    writeManifestRecord(dir, alpha);
    writeManifestRecord(dir, beta);
    const placements = [placementOf(alpha), placementOf(beta), { slug: 'new', fingerprint: null, updated_at: 'x' }];
    assert.deepEqual(loadShardManifest(dir, SHARD, placements, 'new'), { ...alpha.files, ...beta.files });
    assert.deepEqual(loadShardManifest(dir, SHARD, [placementOf(alpha)], 'alpha'), {});
  }));

test('loadShardManifest aborts listing every stale or missing slug', () =>
  withDir((dir) => {
    const alpha = record('alpha', { '/alpha/index.html': 'a' });
    writeManifestRecord(dir, alpha);
    const placements = [{ ...placementOf(alpha), fingerprint: 'other' }, { slug: 'gone', fingerprint: 'f', updated_at: 'x' }];
    assert.throws(() => loadShardManifest(dir, SHARD, placements, 'new'), (error) => {
      assert.ok(error instanceof ShardStateMismatchError);
      assert.deepEqual(error.problems, ['alpha: fingerprint differs from D1', 'gone: no local manifest']);
      return true;
    });
  }));
