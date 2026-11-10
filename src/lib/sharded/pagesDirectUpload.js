import { readFile } from 'node:fs/promises';

import { cloudflareFetch, CloudflareHttpError } from '../cloudflareApi.js';

// wrangler's bucket limits for /pages/assets/upload (40 MiB, 1000 files on Windows).
const MAX_BUCKET_BYTES = 40 * 1024 * 1024;
const MAX_BUCKET_FILES = 1000;
const UPLOAD_CONCURRENCY = 3;
const MAX_ATTEMPTS = 3;
const JWT_UNAUTHORIZED_CODE = 8000013;

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isJwtExpired(jwt, now = Date.now()) {
  try {
    const { exp } = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    return typeof exp === 'number' && exp * 1000 <= now;
  } catch {
    return true;
  }
}

/** Upload JWTs are short-lived; this hands out a fresh one when the cached one expired or was rejected. */
function createJwtSource({ shard, apiToken, accountId, cloudflareFetchFn }) {
  let jwt = null;
  const fetchJwt = async () => {
    const result = await cloudflareFetchFn(
      `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(shard)}/upload-token`,
      { apiToken },
    );
    jwt = result.jwt;
    return jwt;
  };
  return {
    get: () => (jwt && !isJwtExpired(jwt) ? jwt : fetchJwt()),
    invalidate: () => {
      jwt = null;
    },
  };
}

// 5xx, a network failure (fetch throws TypeError) and a rejected JWT are
// transient; a 429 is not retried (.ai/decisions/no-retry-on-rate-limit.md).
function isRetryable(error) {
  if (error?.cloudflareErrorCode === JWT_UNAUTHORIZED_CODE) return true;
  if (error instanceof CloudflareHttpError) return error.status >= 500;
  return error instanceof TypeError;
}

async function callWithJwt(jwtSource, call, sleep) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call(await jwtSource.get());
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error;
      if (error.cloudflareErrorCode === JWT_UNAUTHORIZED_CODE) jwtSource.invalidate();
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

/** Groups files into upload requests, largest first, within wrangler's per-request size/count limits. */
export function packUploadBuckets(files, { maxBytes = MAX_BUCKET_BYTES, maxFiles = MAX_BUCKET_FILES } = {}) {
  const buckets = [];
  for (const file of [...files].sort((a, b) => b.size - a.size)) {
    const bucket = buckets.find((b) => b.bytes + file.size <= maxBytes && b.files.length < maxFiles);
    if (bucket) {
      bucket.files.push(file);
      bucket.bytes += file.size;
    } else {
      buckets.push({ files: [file], bytes: file.size });
    }
  }
  return buckets.map((bucket) => bucket.files);
}

function uniqueByHash(assets) {
  return [...new Map(assets.map((asset) => [asset.hash, asset])).values()];
}

async function toUploadPayload(files, readFileFn) {
  return Promise.all(
    files.map(async (file) => ({
      key: file.hash,
      value: (await readFileFn(file.path)).toString('base64'),
      metadata: { contentType: file.contentType },
      base64: true,
    })),
  );
}

async function runPool(items, concurrency, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(lanes);
}

/**
 * Pages direct upload for one shard, the way `wrangler pages deploy` does it:
 * upload JWT → check-missing → upload only the missing hashes → upsert-hashes.
 * Only this slug's files are touched; other demos' assets are already on the
 * shard. Returns how many distinct files were actually sent.
 * `cloudflareFetchFn`/`readFileFn`/`sleep` are injectable for tests; real
 * callers never pass them.
 */
export async function uploadMissingAssets({
  shard,
  assets,
  apiToken,
  accountId,
  cloudflareFetchFn = cloudflareFetch,
  readFileFn = readFile,
  sleep = sleepMs,
}) {
  const jwtSource = createJwtSource({ shard, apiToken, accountId, cloudflareFetchFn });
  const post = (path, body) => callWithJwt(jwtSource, (jwt) => cloudflareFetchFn(path, { apiToken: jwt, method: 'POST', body }), sleep);
  const unique = uniqueByHash(assets);
  const hashes = unique.map((asset) => asset.hash);

  const missing = new Set(await post('/pages/assets/check-missing', { hashes }));
  const toUpload = unique.filter((asset) => missing.has(asset.hash));
  await runPool(packUploadBuckets(toUpload), UPLOAD_CONCURRENCY, async (files) =>
    post('/pages/assets/upload', await toUploadPayload(files, readFileFn)),
  );
  await post('/pages/assets/upsert-hashes', { hashes });
  return { uploaded: toUpload.length, total: unique.length };
}

/** Publishes `manifest` as the shard's new production deployment. */
export function createDeployment({ shard, manifest, apiToken, accountId, cloudflareFetchFn = cloudflareFetch }) {
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  form.append('branch', 'main');
  return cloudflareFetchFn(`/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(shard)}/deployments`, {
    apiToken,
    method: 'POST',
    body: form,
  });
}
