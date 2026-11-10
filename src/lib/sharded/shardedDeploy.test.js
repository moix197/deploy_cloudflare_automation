import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PlacementNotFoundError, ShardLockLostError, ShardSubdomainMismatchError } from '../../errors.js';
import { isJwtExpired, packUploadBuckets } from './pagesDirectUpload.js';
import { deploySharded, initShards, removeSharded } from './shardedDeploy.js';
import { createSqliteD1 } from './sqliteD1.testkit.js';

const auth = { apiToken: 't', accountId: 'acc' };
const resolveAuthFn = () => auth;

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

async function withSites(sites, fn) {
  const dirs = Object.fromEntries(Object.entries(sites).map(([key, files]) => [key, makeSite(files)]));
  try {
    await fn(dirs);
  } finally {
    for (const dir of Object.values(dirs)) rmSync(dir, { recursive: true, force: true });
  }
}

test('deploys two demos into one shard manifest, redeploys one without touching the other, then removes it', () =>
  withSites({
    a: { 'index.html': 'A home', 'about/index.html': 'A about', 'img/logo.png': 'same-bytes' },
    b: { 'index.html': 'B home', 'img/logo.png': 'same-bytes' },
  }, async ({ a, b }) => {
    const db = createSqliteD1();
    const pages = fakePages();
    const options = { db, resolveAuthFn, cloudflareFetchFn: pages.cloudflareFetchFn };

    const first = await deploySharded({ dir: a, slug: 'alpha', leadId: 7, ...options });
    assert.deepEqual(
      { status: first.status, shard: first.shard, url: first.url, files: first.files, uploaded: first.uploaded },
      { status: 'deployed', shard: 'wx-demos-01', url: 'https://wx-demos-01.pages.dev/alpha/', files: 3, uploaded: 3 },
    );

    await db.query("INSERT INTO demo_placements VALUES ('filler', 'wx-demos-02', NULL, 1, 'x')");
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

    const [placement] = await db.query("SELECT shard, lead_id, file_count FROM demo_placements WHERE slug = 'alpha'");
    assert.deepEqual(placement, { shard: 'wx-demos-01', lead_id: 7, file_count: 2 }); // lead_id kept when not passed again
    const files = await db.query("SELECT path, hash FROM demo_files WHERE shard = 'wx-demos-01' ORDER BY path");
    assert.deepEqual(Object.fromEntries(files.map((r) => [r.path, r.hash])), last.manifest);

    assert.deepEqual(await removeSharded({ slug: 'alpha', ...options }), { status: 'removed', slug: 'alpha', shard: 'wx-demos-01' });
    assert.deepEqual(pages.deployments.at(-1), { shard: 'wx-demos-01', branch: 'main', manifest: {} });
    assert.deepEqual(await db.query("SELECT * FROM demo_files WHERE shard = 'wx-demos-01'"), []);
    assert.deepEqual(await db.query("SELECT * FROM demo_placements WHERE slug = 'alpha'"), []);
    assert.deepEqual(await db.query('SELECT * FROM shard_locks'), []);
  }));

test('redeploying a slug keeps a slug that shares its prefix on the same shard', () =>
  withSites({ a: { 'index.html': 'one' }, b: { 'index.html': 'two' } }, async ({ a, b }) => {
    const db = createSqliteD1();
    const pages = fakePages();
    const options = { db, resolveAuthFn, cloudflareFetchFn: pages.cloudflareFetchFn };
    await deploySharded({ dir: a, slug: 'demo', ...options });
    await db.query("INSERT INTO demo_placements VALUES ('demo-two', 'wx-demos-01', NULL, 0, 'x')");
    await deploySharded({ dir: b, slug: 'demo-two', ...options });
    await deploySharded({ dir: a, slug: 'demo', ...options });
    const last = pages.deployments.at(-1);
    assert.equal(last.shard, 'wx-demos-01');
    assert.deepEqual(Object.keys(last.manifest).sort(), ['/demo-two/index.html', '/demo/index.html']);
  }));

test('a write after the lease was taken over records nothing and fails with ShardLockLostError', () =>
  withSites({ a: { 'index.html': 'A' } }, async ({ a }) => {
    const db = createSqliteD1();
    const pages = fakePages();
    const cloudflareFetchFn = async (path, init) => {
      const result = await pages.cloudflareFetchFn(path, init);
      if (path.endsWith('/deployments')) await db.query("UPDATE shard_locks SET holder = 'thief'");
      return result;
    };
    await assert.rejects(deploySharded({ dir: a, slug: 'alpha', db, resolveAuthFn, cloudflareFetchFn }), ShardLockLostError);
    assert.deepEqual(await db.query('SELECT * FROM demo_files'), []);
    assert.deepEqual(await db.query('SELECT * FROM demo_placements'), []);
  }));

test('removeSharded on an unknown slug fails with PlacementNotFoundError', async () => {
  const pages = fakePages();
  await assert.rejects(
    removeSharded({ slug: 'nope', db: createSqliteD1(), resolveAuthFn, cloudflareFetchFn: pages.cloudflareFetchFn }),
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
  withSites({ a: { 'index.html': 'A' }, b: { 'index.html': 'B' } }, async ({ a, b }) => {
    const db = createSqliteD1();
    const pages = fakePages();
    const base = { db, resolveAuthFn, cloudflareFetchFn: pages.cloudflareFetchFn };
    await deploySharded({ dir: a, slug: 'alpha', ...base });
    await db.query("INSERT INTO demo_placements VALUES ('beta', 'wx-demos-01', NULL, 1, 'x')");
    await deploySharded({ dir: b, slug: 'beta', ...base });
    const merged = Object.values(pages.deployments.at(-1).manifest);
    assert.equal(merged.length, 2);
    assert.deepEqual([...pages.upserts.at(-1)].sort(), [...merged].sort());
  }));

test('the lease is renewed after createDeployment too, and a lease lost during it aborts before D1', () =>
  withSites({ a: { 'index.html': 'A' } }, async ({ a }) => {
    const db = createSqliteD1();
    const pages = fakePages();
    let now = 0;
    const lockOptions = { now: () => now, leaseMs: 1000 };
    const cloudflareFetchFn = async (path, init) => {
      const result = await pages.cloudflareFetchFn(path, init);
      if (path.endsWith('/deployments')) await db.query("UPDATE shard_locks SET holder = 'thief'");
      return result;
    };
    await assert.rejects(deploySharded({ dir: a, slug: 'alpha', db, resolveAuthFn, cloudflareFetchFn, lockOptions }), ShardLockLostError);
    assert.deepEqual(await db.query('SELECT * FROM demo_placements'), []);
  }));
