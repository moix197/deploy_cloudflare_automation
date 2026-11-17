import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PlacementNotFoundError, ShardLockLostError, ShardStateMismatchError, ShardSubdomainMismatchError } from '../../errors.js';
import { manifestFilePath, readManifestRecord, writeManifestRecord } from './manifestStore.js';
import { isJwtExpired, packUploadBuckets } from './pagesDirectUpload.js';
import { deploySharded, initShards, removeSharded } from './shardedDeploy.js';
import { createSqliteD1 } from './sqliteD1.testkit.js';

const auth = { apiToken: 't', accountId: 'acc' };
const resolveAuthFn = () => auth;
const waitUntilServingFn = async () => true;

function jwt(expSeconds) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ exp: expSeconds })}.sig`;
}

/** Stands in for the Pages API: remembers stored hashes per shard and every deployment's manifest. */
function fakePages() {
  const stored = new Map();
  const deployments = [];
  const uploads = [];
  const upserts = [];
  const hashesOf = (shard) => stored.get(shard) ?? stored.set(shard, new Set()).get(shard);
  let tokenShard;
  const cloudflareFetchFn = async (path, { method = 'GET', body } = {}) => {
    const token = path.match(/^\/accounts\/acc\/pages\/projects\/([^/]+)\/upload-token$/);
    if (token) {
      tokenShard = token[1];
      return { jwt: jwt(Math.floor(Date.now() / 1000) + 600) };
    }
    if (path === '/pages/assets/check-missing') return body.hashes.filter((h) => !hashesOf(tokenShard).has(h));
    if (path === '/pages/assets/upload') {
      for (const file of body) hashesOf(tokenShard).add(file.key);
      uploads.push(...body.map((file) => file.key));
      return true;
    }
    if (path === '/pages/assets/upsert-hashes') {
      upserts.push(body.hashes);
      return true;
    }
    const deployment = path.match(/^\/accounts\/acc\/pages\/projects\/([^/]+)\/deployments$/);
    if (deployment && method === 'POST') {
      deployments.push({ shard: deployment[1], branch: body.get('branch'), manifest: JSON.parse(body.get('manifest')) });
      return { url: `https://${deployments.length}.${deployment[1]}.pages.dev` };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { cloudflareFetchFn, deployments, uploads, upserts };
}

function makeSite(files) {
  const dir = mkdtempSync(join(tmpdir(), 'cfpd-sharded-'));
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

/** Site dirs plus a fresh local manifest store (`state.manifestsDir`, git commits stubbed out). */
async function withSites(sites, fn) {
  const dirs = Object.fromEntries(Object.entries(sites).map(([key, files]) => [key, makeSite(files)]));
  const manifestsDir = mkdtempSync(join(tmpdir(), 'cfpd-manifests-'));
  try {
    await fn(dirs, { manifestsDir, commitManifestsFn: () => false });
  } finally {
    for (const dir of [...Object.values(dirs), manifestsDir]) rmSync(dir, { recursive: true, force: true });
  }
}

const placeSlug = (db, slug, shard, fileCount = 1) =>
  db.query("INSERT INTO demo_placements (slug, shard, lead_id, file_count, updated_at) VALUES (?, ?, NULL, ?, 'x')", [slug, shard, fileCount]);

test('deploys two demos into one shard manifest, redeploys one without touching the other, then removes it', () =>
  withSites({
    a: { 'index.html': 'A home', 'about/index.html': 'A about', 'img/logo.png': 'same-bytes' },
    b: { 'index.html': 'B home', 'img/logo.png': 'same-bytes' },
  }, async ({ a, b }, state) => {
    const db = createSqliteD1();
    const pages = fakePages();
    const options = { db, resolveAuthFn, waitUntilServingFn, cloudflareFetchFn: pages.cloudflareFetchFn, ...state };

    const first = await deploySharded({ dir: a, slug: 'alpha', leadId: 7, ...options });
    assert.deepEqual(
      { status: first.status, shard: first.shard, url: first.url, files: first.files, uploaded: first.uploaded },
      { status: 'deployed', shard: 'wx-demos-01', url: 'https://wx-demos-01.pages.dev/alpha/', files: 3, uploaded: 3 },
    );

    await placeSlug(db, 'filler', 'wx-demos-02');
    const second = await deploySharded({ dir: b, slug: 'beta', ...options });
    assert.equal(second.shard, 'wx-demos-03'); // 01 has 3 files, 02 has 1, 03..10 are empty
    assert.equal(second.uploaded, 2);

    unlinkSync(join(a, 'about', 'index.html'));
    writeFileSync(join(a, 'index.html'), 'A home v2');
    const redeploy = await deploySharded({ dir: a, slug: 'alpha', ...options });
    assert.equal(redeploy.shard, 'wx-demos-01');
    assert.equal(redeploy.uploaded, 1); // only the changed index.html; logo already on the shard
    const last = pages.deployments.at(-1);
    assert.equal(last.branch, 'main');
    assert.deepEqual(Object.keys(last.manifest).sort(), ['/alpha/img/logo.png', '/alpha/index.html']);

    const [placement] = await db.query("SELECT shard, lead_id, file_count, fingerprint, updated_at FROM demo_placements WHERE slug = 'alpha'");
    const record = readManifestRecord(state.manifestsDir, 'wx-demos-01', 'alpha');
    assert.deepEqual(placement, { shard: 'wx-demos-01', lead_id: 7, file_count: 2, fingerprint: record.fingerprint, updated_at: record.deployedAt }); // lead_id kept when not passed again
    assert.deepEqual(record.files, last.manifest);
    assert.deepEqual(redeploy.manifest, { path: manifestFilePath(state.manifestsDir, 'wx-demos-01', 'alpha'), fingerprint: record.fingerprint, committed: false });
    const deploymentUrl = async () => (await db.query("SELECT url FROM shard_deployments WHERE shard = 'wx-demos-01'"))[0].url;
    assert.equal(await deploymentUrl(), redeploy.deploymentUrl);
    assert.ok(redeploy.lock.requestedAt <= redeploy.lock.acquiredAt && redeploy.lock.acquiredAt <= redeploy.lock.releasedAt);

    assert.deepEqual(await removeSharded({ slug: 'alpha', ...options }), { status: 'removed', slug: 'alpha', shard: 'wx-demos-01', skipped: [] });
    assert.deepEqual(pages.deployments.at(-1), { shard: 'wx-demos-01', branch: 'main', manifest: {} });
    assert.equal(existsSync(manifestFilePath(state.manifestsDir, 'wx-demos-01', 'alpha')), false);
    assert.deepEqual(await db.query("SELECT * FROM demo_placements WHERE slug = 'alpha'"), []);
    assert.deepEqual(await db.query('SELECT * FROM shard_locks'), []);
    assert.equal(await deploymentUrl(), `https://${pages.deployments.length}.wx-demos-01.pages.dev`);
  }));

test('redeploying a slug keeps a slug that shares its prefix on the same shard', () =>
  withSites({ a: { 'index.html': 'one' }, b: { 'index.html': 'two' } }, async ({ a, b }, state) => {
    const db = createSqliteD1();
    const pages = fakePages();
    const options = { db, resolveAuthFn, waitUntilServingFn, cloudflareFetchFn: pages.cloudflareFetchFn, ...state };
    await deploySharded({ dir: a, slug: 'demo', ...options });
    await placeSlug(db, 'demo-two', 'wx-demos-01', 0);
    await deploySharded({ dir: b, slug: 'demo-two', ...options });
    await deploySharded({ dir: a, slug: 'demo', ...options });
    const last = pages.deployments.at(-1);
    assert.equal(last.shard, 'wx-demos-01');
    assert.deepEqual(Object.keys(last.manifest).sort(), ['/demo-two/index.html', '/demo/index.html']);
  }));

test('a write after the lease was taken over records nothing and fails with ShardLockLostError', () =>
  withSites({ a: { 'index.html': 'A' } }, async ({ a }, state) => {
    const db = createSqliteD1();
    const pages = fakePages();
    const cloudflareFetchFn = async (path, init) => {
      const result = await pages.cloudflareFetchFn(path, init);
      if (path.endsWith('/deployments')) await db.query("UPDATE shard_locks SET holder = 'thief'");
      return result;
    };
    await assert.rejects(deploySharded({ dir: a, slug: 'alpha', db, resolveAuthFn, waitUntilServingFn, cloudflareFetchFn, ...state }), ShardLockLostError);
    assert.equal(readManifestRecord(state.manifestsDir, 'wx-demos-01', 'alpha'), null);
    assert.deepEqual(await db.query('SELECT * FROM demo_placements'), []);
    assert.deepEqual(await db.query('SELECT * FROM shard_deployments'), []);
  }));

test('removeSharded on an unknown slug fails with PlacementNotFoundError', async () => {
  const pages = fakePages();
  await assert.rejects(
    removeSharded({ slug: 'nope', db: createSqliteD1(), resolveAuthFn, waitUntilServingFn, cloudflareFetchFn: pages.cloudflareFetchFn }),
    PlacementNotFoundError,
  );
});

test('initShards ensures every shard and rejects one served at another subdomain', async () => {
  const ensured = [];
  const ok = await initShards({
    shards: ['wx-demos-01', 'wx-demos-02'],
    resolveAuthFn,
    ensureProjectFn: async ({ slug }) => {
      ensured.push(slug);
      return { subdomain: `${slug}.pages.dev` };
    },
  });
  assert.deepEqual(ok, { status: 'ready', shards: ['wx-demos-01', 'wx-demos-02'], count: 2 });
  assert.deepEqual(ensured, ['wx-demos-01', 'wx-demos-02']);
  await assert.rejects(
    initShards({ shards: ['wx-demos-01'], resolveAuthFn, ensureProjectFn: async () => ({ subdomain: 'wx-demos-01-x1y.pages.dev' }) }),
    ShardSubdomainMismatchError,
  );
});

test('upload buckets respect the byte and file caps, largest files first', () => {
  const files = [{ size: 5 }, { size: 30 }, { size: 20 }, { size: 1 }];
  assert.deepEqual(packUploadBuckets(files, { maxBytes: 40, maxFiles: 2 }).map((b) => b.map((f) => f.size)), [[30, 5], [20, 1]]);
});

test('isJwtExpired reads exp; garbage counts as expired', () => {
  assert.equal(isJwtExpired(jwt(100), 99_000), false);
  assert.equal(isJwtExpired(jwt(100), 100_000), true);
  assert.equal(isJwtExpired('not-a-jwt'), true);
});

test('the deployment upserts every hash of the merged manifest, other demos included', () =>
  withSites({ a: { 'index.html': 'A' }, b: { 'index.html': 'B' } }, async ({ a, b }, state) => {
    const db = createSqliteD1();
    const pages = fakePages();
    const base = { db, resolveAuthFn, waitUntilServingFn, cloudflareFetchFn: pages.cloudflareFetchFn, ...state };
    await deploySharded({ dir: a, slug: 'alpha', ...base });
    await placeSlug(db, 'beta', 'wx-demos-01');
    await deploySharded({ dir: b, slug: 'beta', ...base });
    const merged = Object.values(pages.deployments.at(-1).manifest);
    assert.equal(merged.length, 2);
    assert.deepEqual([...pages.upserts.at(-1)].sort(), [...merged].sort());
  }));

test('the lease is renewed after createDeployment too, and a lease lost during it aborts before D1', () =>
  withSites({ a: { 'index.html': 'A' } }, async ({ a }, state) => {
    const db = createSqliteD1();
    const pages = fakePages();
    let now = 0;
    const lockOptions = { now: () => now, leaseMs: 1000 };
    const cloudflareFetchFn = async (path, init) => {
      const result = await pages.cloudflareFetchFn(path, init);
      if (path.endsWith('/deployments')) await db.query("UPDATE shard_locks SET holder = 'thief'");
      return result;
    };
    await assert.rejects(deploySharded({ dir: a, slug: 'alpha', db, resolveAuthFn, waitUntilServingFn, cloudflareFetchFn, lockOptions, ...state }), ShardLockLostError);
    assert.deepEqual(await db.query('SELECT * FROM demo_placements'), []);
  }));

test('a deploy writes 2 D1 rows (placement + shard deployment) whatever the demo size', async () => {
  const files = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`p${i}.html`, `page ${i}`]));
  await withSites({ a: files }, async ({ a }, state) => {
    const db = createSqliteD1();
    const writes = [];
    const batch = db.batch;
    db.batch = (statements) => {
      writes.push(statements.filter((s) => /^(INSERT INTO|UPDATE|DELETE FROM) (?!shard_locks)/.test(s.sql)).length);
      return batch(statements);
    };
    const pages = fakePages();
    const options = { db, resolveAuthFn, waitUntilServingFn, cloudflareFetchFn: pages.cloudflareFetchFn, ...state };
    await deploySharded({ dir: a, slug: 'alpha', ...options });
    assert.equal(writes.reduce((sum, n) => sum + n, 0), 2);
    assert.equal(Object.keys(readManifestRecord(state.manifestsDir, 'wx-demos-01', 'alpha').files).length, 100);
  });
});

/** alpha and beta live on wx-demos-01; `redeployAlpha` asserts the redeploy aborts on beta's state without deploying. */
async function twoDemosOnOneShard({ a, b }, state) {
  const db = createSqliteD1();
  const pages = fakePages();
  const options = { db, resolveAuthFn, waitUntilServingFn, cloudflareFetchFn: pages.cloudflareFetchFn, ...state };
  await deploySharded({ dir: a, slug: 'alpha', ...options });
  await placeSlug(db, 'beta', 'wx-demos-01');
  await deploySharded({ dir: b, slug: 'beta', ...options });
  const redeployAlpha = async () => {
    const before = pages.deployments.length;
    await assert.rejects(deploySharded({ dir: a, slug: 'alpha', ...options }), (error) => {
      assert.ok(error instanceof ShardStateMismatchError);
      assert.equal(error.code, 'SHARD_STATE_MISMATCH');
      assert.match(error.problems[0], /^beta: /);
      return true;
    });
    assert.equal(pages.deployments.length, before, 'no deployment from stale state');
  };
  return { db, redeployAlpha };
}

const twoSites = { a: { 'index.html': 'A' }, b: { 'index.html': 'B' } };

test('a missing local manifest of another demo on the shard aborts before any deployment', () =>
  withSites(twoSites, async (sites, state) => {
    const { redeployAlpha } = await twoDemosOnOneShard(sites, state);
    unlinkSync(manifestFilePath(state.manifestsDir, 'wx-demos-01', 'beta'));
    await redeployAlpha();
  }));

test('a hand-edited local manifest (fingerprint no longer matches its files) aborts', () =>
  withSites(twoSites, async (sites, state) => {
    const { redeployAlpha } = await twoDemosOnOneShard(sites, state);
    const record = readManifestRecord(state.manifestsDir, 'wx-demos-01', 'beta');
    writeManifestRecord(state.manifestsDir, { ...record, files: { ...record.files, '/beta/extra.html': 'h' } });
    await redeployAlpha();
  }));

test('a deploy recorded in D1 but not in the local file (other machine, old code) aborts', () =>
  withSites(twoSites, async (sites, state) => {
    const { db, redeployAlpha } = await twoDemosOnOneShard(sites, state);
    await db.query("UPDATE demo_placements SET updated_at = '2099-01-01T00:00:00.000Z' WHERE slug = 'beta'");
    await redeployAlpha();
  }));

test('removing a demo is refused while another demo on its shard has stale local state', () =>
  withSites(twoSites, async (sites, state) => {
    const { db } = await twoDemosOnOneShard(sites, state);
    await db.query("UPDATE demo_placements SET fingerprint = 'other' WHERE slug = 'beta'");
    const pages = fakePages();
    await assert.rejects(
      removeSharded({ slug: 'alpha', db, resolveAuthFn, waitUntilServingFn, cloudflareFetchFn: pages.cloudflareFetchFn, ...state }),
      ShardStateMismatchError,
    );
    assert.equal(pages.deployments.length, 0);
    assert.ok(readManifestRecord(state.manifestsDir, 'wx-demos-01', 'alpha'));
  }));

const threeSites = { a: { 'index.html': 'A' }, b: { 'index.html': 'B' }, c: { 'index.html': 'C' } };

/** alpha, beta and gamma live on wx-demos-01. */
async function threeDemosOnOneShard({ a, b, c }, state) {
  const db = createSqliteD1();
  const pages = fakePages();
  const options = { db, resolveAuthFn, waitUntilServingFn, cloudflareFetchFn: pages.cloudflareFetchFn, ...state };
  await deploySharded({ dir: a, slug: 'alpha', ...options });
  for (const [slug, dir] of [['beta', b], ['gamma', c]]) {
    await placeSlug(db, slug, 'wx-demos-01');
    await deploySharded({ dir, slug, ...options });
  }
  return { db, pages, options };
}

const fingerprintOfSlug = async (db, slug) => (await db.query('SELECT fingerprint FROM demo_placements WHERE slug = ?', [slug]))[0]?.fingerprint;

test('skipStale with one stale neighbour deploys without it, keeps its placement and marks it offline', () =>
  withSites(threeSites, async (sites, state) => {
    const { db, pages, options } = await threeDemosOnOneShard(sites, state);
    const updatedAt = (await db.query("SELECT updated_at FROM demo_placements WHERE slug = 'beta'"))[0].updated_at;
    unlinkSync(manifestFilePath(state.manifestsDir, 'wx-demos-01', 'beta'));

    const result = await deploySharded({ dir: sites.a, slug: 'alpha', skipStale: ['beta'], ...options });
    assert.deepEqual(result.skipped, [{ slug: 'beta', leadId: null, problem: 'no local manifest' }]);
    assert.deepEqual(Object.keys(pages.deployments.at(-1).manifest).sort(), ['/alpha/index.html', '/gamma/index.html']);
    assert.deepEqual(await db.query("SELECT shard, fingerprint, updated_at FROM demo_placements WHERE slug = 'beta'"), [{ shard: 'wx-demos-01', fingerprint: 'offline', updated_at: updatedAt }]);

    const plain = await deploySharded({ dir: sites.a, slug: 'alpha', ...options });
    assert.deepEqual(plain.skipped, [], 'an offline slug no longer blocks a default deploy');
    assert.deepEqual(Object.keys(pages.deployments.at(-1).manifest).sort(), ['/alpha/index.html', '/gamma/index.html']);
  }));

test('skipStale resolves the two-stale-slugs deadlock; each skipped slug redeploys and is a valid neighbour again', () =>
  withSites(threeSites, async (sites, state) => {
    const { db, pages, options } = await threeDemosOnOneShard(sites, state);
    unlinkSync(manifestFilePath(state.manifestsDir, 'wx-demos-01', 'alpha'));
    await db.query("UPDATE demo_placements SET updated_at = '2099-01-01T00:00:00.000Z' WHERE slug = 'gamma'");

    // Deadlock without the flag: each stale slug is blocked by the other.
    await assert.rejects(deploySharded({ dir: sites.a, slug: 'alpha', ...options }), ShardStateMismatchError);
    await assert.rejects(deploySharded({ dir: sites.c, slug: 'gamma', ...options }), ShardStateMismatchError);

    const first = await deploySharded({ dir: sites.a, slug: 'alpha', skipStale: ['gamma'], ...options });
    assert.deepEqual(first.skipped.map((s) => s.slug), ['gamma']);
    assert.equal(await fingerprintOfSlug(db, 'gamma'), 'offline');

    const second = await deploySharded({ dir: sites.c, slug: 'gamma', ...options });
    assert.deepEqual(second.skipped, []);
    assert.equal(await fingerprintOfSlug(db, 'gamma'), readManifestRecord(state.manifestsDir, 'wx-demos-01', 'gamma').fingerprint);
    assert.deepEqual(Object.keys(pages.deployments.at(-1).manifest).sort(), ['/alpha/index.html', '/beta/index.html', '/gamma/index.html']);

    await deploySharded({ dir: sites.b, slug: 'beta', ...options });
    assert.deepEqual(Object.keys(pages.deployments.at(-1).manifest).sort(), ['/alpha/index.html', '/beta/index.html', '/gamma/index.html'], 'gamma is a verified neighbour again');
  }));

test('remove with skipStale takes the stale neighbour offline instead of refusing', () =>
  withSites(twoSites, async (sites, state) => {
    const { db } = await twoDemosOnOneShard(sites, state);
    await db.query("UPDATE demo_placements SET fingerprint = 'other' WHERE slug = 'beta'");
    const pages = fakePages();
    const result = await removeSharded({ slug: 'alpha', skipStale: ['beta'], db, resolveAuthFn, waitUntilServingFn, cloudflareFetchFn: pages.cloudflareFetchFn, ...state });
    assert.deepEqual(result.skipped, [{ slug: 'beta', leadId: null, problem: 'fingerprint differs from D1' }]);
    assert.deepEqual(pages.deployments.at(-1).manifest, {});
    assert.equal(await fingerprintOfSlug(db, 'beta'), 'offline');
    assert.deepEqual(await db.query("SELECT * FROM demo_placements WHERE slug = 'alpha'"), []);
  }));

test('SHARD_STATE_MISMATCH carries the stale slugs with their lead ids', () =>
  withSites(twoSites, async (sites, state) => {
    const { db, redeployAlpha } = await twoDemosOnOneShard(sites, state);
    await db.query("UPDATE demo_placements SET lead_id = 42 WHERE slug = 'beta'");
    unlinkSync(manifestFilePath(state.manifestsDir, 'wx-demos-01', 'beta'));
    await redeployAlpha();
    await assert.rejects(deploySharded({ dir: sites.a, slug: 'alpha', db, resolveAuthFn, waitUntilServingFn, cloudflareFetchFn: fakePages().cloudflareFetchFn, ...state }), (error) => {
      assert.deepEqual(error.details, { shard: 'wx-demos-01', stale: [{ slug: 'beta', leadId: 42, problem: 'no local manifest' }] });
      return true;
    });
  }));

test('skipStale takes only the listed slugs offline: a neighbour that went stale since aborts the retry', () =>
  withSites(threeSites, async (sites, state) => {
    const { db, pages, options } = await threeDemosOnOneShard(sites, state);
    unlinkSync(manifestFilePath(state.manifestsDir, 'wx-demos-01', 'beta'));
    await assert.rejects(deploySharded({ dir: sites.a, slug: 'alpha', ...options }), (error) => {
      assert.deepEqual(error.details.stale.map((s) => s.slug), ['beta']);
      return true;
    });

    // Between the attempts gamma goes stale too; the retry was judged on beta only.
    await db.query("UPDATE demo_placements SET updated_at = '2099-01-01T00:00:00.000Z' WHERE slug = 'gamma'");
    const before = pages.deployments.length;
    await assert.rejects(deploySharded({ dir: sites.a, slug: 'alpha', skipStale: ['beta'], ...options }), (error) => {
      assert.equal(error.code, 'SHARD_STATE_MISMATCH');
      assert.deepEqual(error.details.stale.map((s) => s.slug), ['gamma']);
      return true;
    });
    assert.equal(pages.deployments.length, before, 'nothing deployed');
    assert.ok(await fingerprintOfSlug(db, 'beta') !== 'offline', 'beta not marked offline');
  }));

test('--skip-stale=<slug,...> parses to a slug list; absent means none', async () => {
  const { parseSkipStale } = await import('../../cli/commands/deploy.js');
  assert.deepEqual(parseSkipStale(['--sharded', '--skip-stale=beta, gamma']), ['beta', 'gamma']);
  assert.deepEqual(parseSkipStale(['--sharded']), []);
  assert.deepEqual(parseSkipStale(['--skip-stale']), []);
});
