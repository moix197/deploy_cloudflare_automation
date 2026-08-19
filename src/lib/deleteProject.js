import { cloudflareFetch, CloudflareHttpError } from './cloudflareApi.js';
import { ProjectNotFoundError } from '../errors.js';

/**
 * Deletes a Pages project by slug. A 404 is mapped to a typed
 * `ProjectNotFoundError` rather than surfacing the raw `CloudflareHttpError`,
 * so callers (and the CLI) can distinguish "already gone" from a genuine
 * transport/API failure. `cloudflareFetchFn` is injectable for tests; real
 * callers never pass it.
 */
export async function deleteProject({ slug, apiToken, accountId, cloudflareFetchFn = cloudflareFetch }) {
  try {
    await cloudflareFetchFn(`/accounts/${accountId}/pages/projects/${slug}`, { apiToken, method: 'DELETE' });
  } catch (error) {
    if (error instanceof CloudflareHttpError && error.status === 404) {
      throw new ProjectNotFoundError(slug);
    }
    throw error;
  }
  return { slug, status: 'deleted' };
}
