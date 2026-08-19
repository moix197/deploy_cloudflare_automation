import { cloudflareFetch, CloudflareHttpError } from './cloudflareApi.js';
import { ProjectNotFoundError } from '../errors.js';
import { validateSlug } from './validate.js';
import { resolveAuth } from '../auth/resolveAuth.js';

/**
 * Deletes a Pages project by slug. A 404 is mapped to a typed
 * `ProjectNotFoundError` rather than surfacing the raw `CloudflareHttpError`,
 * so callers (and the CLI) can distinguish "already gone" from a genuine
 * transport/API failure. Self-resolves `{apiToken, accountId}` the same way
 * `deploy()` does when the caller doesn't supply them (explicit args still
 * win — see `resolveAuth`'s precedence). `cloudflareFetchFn`/`resolveAuthFn`
 * are injectable for tests; real callers never pass them.
 *
 * `slug` is validated with the same `validateSlug` `deploy` uses BEFORE any
 * network call — this is the destructive path, and the exported library API
 * is reachable directly (not just via the CLI's `!slug` guard), so a
 * traversal-shaped slug (`..`, `a/../b`, a slug containing `/`) must never
 * reach the URL. `encodeURIComponent` on the way into the path is defence in
 * depth on top of that validation, not a substitute for it.
 */
export async function deleteProject({ slug, apiToken, accountId, cloudflareFetchFn = cloudflareFetch, resolveAuthFn = resolveAuth } = {}) {
  validateSlug(slug);
  ({ apiToken, accountId } = resolveAuthFn({ apiToken, accountId }));
  try {
    await cloudflareFetchFn(`/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(slug)}`, {
      apiToken,
      method: 'DELETE',
    });
  } catch (error) {
    if (error instanceof CloudflareHttpError && error.status === 404) {
      throw new ProjectNotFoundError(slug);
    }
    throw error;
  }
  return { slug, status: 'deleted' };
}
