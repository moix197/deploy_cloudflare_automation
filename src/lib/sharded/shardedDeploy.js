import { resolve as resolvePath } from 'node:path';

import { resolveAuth, resolveDemosDatabaseId } from '../../auth/resolveAuth.js';
import { CliError, PlacementNotFoundError, ShardFileLimitError, ShardsFullError, ShardSubdomainMismatchError } from '../../errors.js';
import { cloudflareFetch } from '../cloudflareApi.js';
import { ensureProject } from '../ensureProject.js';
import { validateDir, validateSlug } from '../validate.js';
import { walkAssets } from './assets.js';
import { createD1Executor } from './d1.js';
import { mergeSlugManifest, toSlugManifest, withoutSlug } from './manifest.js';
import { createDeployment, uploadMissingAssets } from './pagesDirectUpload.js';
import {
  commitUnderLease,
  getPlacement,
  readShardLoads,
  readShardManifest,
  slugRemoveStatements,
  slugWriteStatements,
} from './placementStore.js';
import { chooseShard, PAGES_FILE_LIMIT, shardNames } from './shards.js';
import { withShardLock } from './shardLock.js';

function noop() {}

/**
 * Credentials, the D1 executor and the Cloudflare client shared by every
 * sharded operation. `db`/`cloudflareFetchFn`/`resolveAuthFn`/`lockOptions`
 * are injectable for tests; real callers never pass them.
 */
function shardedContext({ apiToken, accountId, databaseId, db, cloudflareFetchFn = cloudflareFetch, resolveAuthFn = resolveAuth, lockOptions }) {
  const auth = resolveAuthFn({ apiToken, accountId });
  const executor = db ?? createD1Executor({ ...auth, databaseId: resolveDemosDatabaseId(databaseId), cloudflareFetchFn });
  return { ...auth, db: executor, cloudflareFetchFn, lockOptions };
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

async function publishManifest(ctx, lease, manifest) {
  await lease.renew();
  return createDeployment({ shard: lease.shard, manifest, apiToken: ctx.apiToken, accountId: ctx.accountId, cloudflareFetchFn: ctx.cloudflareFetchFn });
}

async function publishSlug(ctx, lease, { slug, leadId, slugManifest }) {
  await assertPlacementOn(ctx.db, slug, lease.shard);
  const merged = mergeSlugManifest(await readShardManifest(ctx.db, lease.shard), slug, slugManifest);
  assertWithinPagesLimit(lease.shard, merged);
  const deployment = await publishManifest(ctx, lease, merged);
  const updatedAt = new Date().toISOString();
  await commitUnderLease(ctx.db, lease, slugWriteStatements({ lease, slug, leadId, slugManifest, updatedAt }));
  return deployment;
}

/**
 * Publishes `dir` as `/<slug>/` inside one of the shared shard projects
 * without needing any other demo's files locally: upload this slug's
 * missing assets, then — under the shard's lease — merge its entries into
 * the shard manifest stored in D1, create the deployment from it and record
 * manifest + placement in one D1 transaction.
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
  const deployment = await withShardLock(ctx.db, shard, (lease) => publishSlug(ctx, lease, { slug, leadId, slugManifest }), ctx.lockOptions);
  return {
    status: 'deployed',
    slug,
    shard,
    url: `https://${shard}.pages.dev/${slug}/`,
    deploymentUrl: deployment.url,
    files: assets.length,
    uploaded,
  };
}

async function unpublishSlug(ctx, lease, slug) {
  const remaining = withoutSlug(await readShardManifest(ctx.db, lease.shard), slug);
  await publishManifest(ctx, lease, remaining);
  await commitUnderLease(ctx.db, lease, slugRemoveStatements({ lease, slug }));
}

/** Takes `/<slug>/` out of its shard: redeploys the shard without it and drops its manifest rows and placement. */
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
