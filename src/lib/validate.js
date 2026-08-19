import { existsSync, readdirSync, statSync } from 'node:fs';

import { DirectoryNotFoundError, EmptyDirectoryError, InvalidSlugError } from '../errors.js';

// Semi-official: surfaced via Cloudflare API error 8000003, not documented in
// prose, no published reserved-name list. Validated client-side for a fast,
// precise error before any network call.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$|^[a-z0-9]$/;

export function validateSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new InvalidSlugError(slug);
  }
  return slug;
}

export function validateDir(dir) {
  if (typeof dir !== 'string' || !existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new DirectoryNotFoundError(dir);
  }
  if (readdirSync(dir).length === 0) {
    throw new EmptyDirectoryError(dir);
  }
  return dir;
}
