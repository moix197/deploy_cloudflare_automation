import { resolve as resolvePath } from 'node:path';

import { resolveAuth, resolveDemosDatabaseId } from '../../auth/resolveAuth.js';
import { CliError, PlacementNotFoundError, ShardFileLimitError, ShardsFullError, ShardSubdomainMismatchError } from '../../errors.js';
import { cloudflareFetch } from '../cloudflareApi.js';
import { ensureProject } from '../ensureProject.js';
import { validateDir, validateSlug } from '../validate.js';
import { walkAssets } from './assets.js';
import { createD1Executor } from './d1.js';
import { mergeSlugManifest, toSlugManifest } from './manifest.js';
import {
  commitManifests,
  DEFAULT_MANIFESTS_DIR,
  loadShardManifest,
  removeManifestRecord,
  toManifestRecord,
  writeManifestRecord,
} from './manifestStore.js';
import { createDeployment, uploadMissingAssets, upsertManifestHashes, waitUntilServing } from './pagesDirectUpload.js';
import {
  commitUnderLease,
  getPlacement,
  readShardLoads,
  readShardPlacements,
  slugRemoveStatements,
  slugWriteStatements,
} from './placementStore.js';
import { chooseShard, PAGES_FILE_LIMIT, shardNames } from './shards.js';
import { withShardLock } from './shardLock.js';

function noop() {}

const isoNow = () => new Date().toISOString();

/**
 * Credentials, the D1 executor, the Cloudflare client and the local manifest
 * store shared by every sharded operation. `db`/`cloudflareFetchFn`/
 * `resolveAuthFn`/`lockOptions`/`waitUntilServingFn`/`manifestsDir`/
 * `commitManifestsFn` are injectable for tests; real callers never pass them.
 */
function shardedContext({
  apiToken,
  accountId,
  databaseId,
  db,
  cloudflareFetchFn = cloudflareFetch,
  resolveAuthFn = resolveAuth,
  lockOptions,
  waitUntilServingFn = waitUntilServing,
  manifestsDir = DEFAULT_MANIFESTS_DIR,
  commitManifestsFn = commitManifests,
}) {
  const auth = resolveAuthFn({ apiToken, accountId });
  const executor = db ?? createD1Executor({ ...auth, databaseId: resolveDemosDatabaseId(databaseId), cloudflareFetchFn });
  return { ...auth, db: executor, cloudflareFetchFn, lockOptions, waitUntilServingFn, manifestsDir, commitManifestsFn };
}

/** Every other slug's live files on the lease's shard, verified against D1 (throws SHARD_STATE_MISMATCH). */
async function loadOtherSlugs(ctx, lease, slug) {
  return loadShardManifest(ctx.manifestsDir, lease.shard, await readShardPlacements(ctx.db, lease.shard), slug);
}

async function pickShard(db, slug, fileCount) {
  const placement = await getPlacement(db, slug);
  const shard = chooseShard({ placement, loads: placement ? {} : await readShardLoads(db), fileCount });
  if (!shard) throw new ShardsFullError(slug, fileCount);
  return shard;
}

/** A concurrent first deploy of the same slug may have placed it elsewhere while we waited for the lock. */
async function assertPlacementOn(db, slug, shard) {
  const placement = await getPlacement(db, slug);
  if (placement && placement.shard !== shard) {
    throw new CliError(`"${slug}" was just placed on ${placement.shard} by a concurrent deploy — rerun`, 'PLACEMENT_CONFLICT');
  }
}

function assertWithinPagesLimit(shard, manifest) {
  const files = Object.keys(manifest).length;
  if (files > PAGES_FILE_LIMIT) throw new ShardFileLimitError(shard, files, PAGES_FILE_LIMIT);
}

/**
 * Renews before and after the slow Cloudflare calls (the lease is longer than
 * either); losing it throws, so nothing is committed to D1.
 */
async function publishManifest(ctx, lease, manifest) {
  const cloudflare = { shard: lease.shard, manifest, apiToken: ctx.apiToken, accountId: ctx.accountId, cloudflareFetchFn: ctx.cloudflareFetchFn };
  await lease.renew();
  await upsertManifestHashes(cloudflare);
  await lease.renew();
  const deployment = await createDeployment(cloudflare);
  await lease.renew();
  await ctx.waitUntilServingFn(deployment.url, probePath(manifest));
  await lease.renew();
  return deployment;
}

function probePath(manifest) {
  const [first] = Object.keys(manifest);
  return first ? encodeURI(first) : '/';
}

/**
 * D1 first: a lost lease records nothing, and a D1 row whose file never got
 * written is caught as a fingerprint mismatch by the shard's next deploy.
 */
async function recordLiveManifest(ctx, lease, record) {
  await commitUnderLease(ctx.db, lease, slugWriteStatements({ lease, record }));
  const path = writeManifestRecord(ctx.manifestsDir, record);
  const committed = ctx.commitManifestsFn(ctx.manifestsDir, `Manifest: ${record.slug} live on ${record.shard} (${record.fileCount} files)`);
  return { path, fingerprint: record.fingerprint, committed };
}

async function publishSlug(ctx, lease, { slug, leadId, slugManifest }) {
  await assertPlacementOn(ctx.db, slug, lease.shard);
  const merged = mergeSlugManifest(await loadOtherSlugs(ctx, lease, slug), slug, slugManifest);
  assertWithinPagesLimit(lease.shard, merged);
  const deployment = await publishManifest(ctx, lease, merged);
  const record = toManifestRecord({ slug, shard: lease.shard, leadId, files: slugManifest, deployedAt: isoNow(), deploymentUrl: deployment.url });
  const manifest = await recordLiveManifest(ctx, lease, record);
  return { deployment, manifest };
}

/**
 * Publishes `dir` as `/<slug>/` inside one of the shared shard projects
 * without needing any other demo's files locally: upload this slug's
 * missing assets, then, under the shard's lease, merge its entries with the
 * other demos' local manifests (each verified against its D1 fingerprint),
 * create the deployment, record placement + fingerprint in one D1
 * transaction and write this slug's manifest file.
 */
export async function deploySharded({ dir, slug, leadId = null, onProgress = noop, ...options } = {}) {
  validateSlug(slug);
  const absoluteDir = resolvePath(validateDir(dir));
  const ctx = shardedContext(options);
  const assets = walkAssets(absoluteDir);
  const shard = await pickShard(ctx.db, slug, assets.length);

  onProgress('uploading');
  const { uploaded } = await uploadMissingAssets({ shard, assets, apiToken: ctx.apiToken, accountId: ctx.accountId, cloudflareFetchFn: ctx.cloudflareFetchFn });

  onProgress('publishing');
  const slugManifest = toSlugManifest(slug, assets);
  // Timestamps let concurrent same-shard deploys show they ran one after the other.
  const lock = { requestedAt: isoNow() };
  const { deployment, manifest } = await withShardLock(ctx.db, shard, (lease) => {
    lock.acquiredAt = isoNow();
    return publishSlug(ctx, lease, { slug, leadId, slugManifest });
  }, ctx.lockOptions);
  lock.releasedAt = isoNow();
  return {
    status: 'deployed',
    slug,
    shard,
    url: `https://${shard}.pages.dev/${slug}/`,
    deploymentUrl: deployment.url,
    files: assets.length,
    uploaded,
    lock,
    manifest,
  };
}

async function unpublishSlug(ctx, lease, slug) {
  const remaining = await loadOtherSlugs(ctx, lease, slug);
  const deployment = await publishManifest(ctx, lease, remaining);
  await commitUnderLease(ctx.db, lease, slugRemoveStatements({ lease, slug, deploymentUrl: deployment.url, updatedAt: isoNow() }));
  removeManifestRecord(ctx.manifestsDir, lease.shard, slug);
  ctx.commitManifestsFn(ctx.manifestsDir, `Manifest: ${slug} removed from ${lease.shard}`);
}

/** Takes `/<slug>/` out of its shard: redeploys the shard without it and drops its placement and manifest file. */
export async function removeSharded({ slug, ...options } = {}) {
  validateSlug(slug);
  const ctx = shardedContext(options);
  const placement = await getPlacement(ctx.db, slug);
  if (!placement) throw new PlacementNotFoundError(slug);
  await withShardLock(ctx.db, placement.shard, (lease) => unpublishSlug(ctx, lease, slug), ctx.lockOptions);
  return { status: 'removed', slug, shard: placement.shard };
}

/**
 * Idempotently creates the shard projects and confirms each is served at
 * `<name>.pages.dev`, the address the routing Worker proxies to.
 * `ensureProjectFn`/`resolveAuthFn` are injectable for tests; real callers never pass them.
 */
export async function initShards({ shards = shardNames(), apiToken, accountId, ensureProjectFn = ensureProject, resolveAuthFn = resolveAuth } = {}) {
  const auth = resolveAuthFn({ apiToken, accountId });
  for (const name of shards) {
    const project = await ensureProjectFn({ slug: name, ...auth });
    if (project.subdomain !== `${name}.pages.dev`) throw new ShardSubdomainMismatchError(name, project.subdomain);
  }
  return { status: 'ready', shards, count: shards.length };
}
