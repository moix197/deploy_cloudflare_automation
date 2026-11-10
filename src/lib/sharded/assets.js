import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { hash as blake3 } from 'blake3-wasm';

import { CliError } from '../../errors.js';
import { contentTypeFor } from './contentType.js';

// Pages' per-file cap (wrangler's MAX_ASSET_SIZE).
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

// wrangler's `pages deploy` ignore list: these root entries are deployment
// config, not assets (a demo's own _headers/_redirects would only apply at
// the shard root anyway), and these names are skipped at any depth.
const IGNORED_AT_ROOT = new Set(['_worker.js', '_redirects', '_headers', '_routes.json', 'functions', '.wrangler']);
const IGNORED_ANYWHERE = new Set(['.DS_Store', 'node_modules', '.git']);

/**
 * Pages' asset key, byte-for-byte wrangler's `hashFile`: blake3 over the
 * base64 of the contents with the bare extension appended, first 32 hex
 * chars. Any drift here makes check-missing re-upload everything and, worse,
 * mismatches what Cloudflare stores — assets.test.js compares it against
 * wrangler's own function.
 */
export function hashAsset(contents, extension) {
  return blake3(contents.toString('base64') + extension).toString('hex').slice(0, 32);
}

export function hashAssetFile(filePath) {
  return hashAsset(readFileSync(filePath), extname(filePath).substring(1));
}

function isIgnored(name, isRoot) {
  return IGNORED_ANYWHERE.has(name) || (isRoot && IGNORED_AT_ROOT.has(name));
}

function toAsset(filePath, name, size) {
  if (size > MAX_ASSET_BYTES) {
    throw new CliError(`Pages only supports files up to 25 MiB; ${name} is ${size} bytes`, 'FILE_TOO_LARGE');
  }
  return { name, path: filePath, size, contentType: contentTypeFor(name), hash: hashAssetFile(filePath) };
}

/**
 * Every deployable file under `dir`, as `{name, path, size, contentType,
 * hash}` with `name` the `/`-separated path relative to `dir`, sorted by name.
 */
export function walkAssets(dir, prefix = '') {
  const assets = [];
  for (const entry of readdirSync(dir)) {
    if (isIgnored(entry, prefix === '')) continue;
    const filePath = join(dir, entry);
    const name = `${prefix}${entry}`;
    const stats = statSync(filePath);
    if (stats.isDirectory()) assets.push(...walkAssets(filePath, `${name}/`));
    else assets.push(toAsset(filePath, name, stats.size));
  }
  return assets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
