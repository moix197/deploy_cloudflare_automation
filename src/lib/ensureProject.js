import { cloudflareFetch, CloudflareApiError, CloudflareHttpError } from './cloudflareApi.js';
import { ProjectCreateError, SlugTakenError } from '../errors.js';

const SLUG_TAKEN_CODE = 8000003;

function isCloudflareApiFailure(error) {
  return error instanceof CloudflareHttpError || error instanceof CloudflareApiError;
}

async function getProject({ slug, apiToken, accountId, cloudflareFetchFn }) {
  try {
    return await cloudflareFetchFn(`/accounts/${accountId}/pages/projects/${slug}`, { apiToken });
  } catch (error) {
    if (error instanceof CloudflareHttpError && error.status === 404) return null;
    throw error;
  }
}

function createProject({ slug, apiToken, accountId, cloudflareFetchFn }) {
  return cloudflareFetchFn(`/accounts/${accountId}/pages/projects`, {
    apiToken,
    method: 'POST',
    body: { name: slug, production_branch: 'main' },
  });
}

/**
 * A create failure with the "slug taken" code can mean two things: a
 * concurrent request from this same account just created it (recoverable —
 * re-GET finds it), or the name is genuinely taken elsewhere (unrecoverable).
 * The re-GET is what tells them apart.
 */
async function resolveSlugTakenConflict(context, cause) {
  const existing = await getProject(context);
  if (existing) return existing;
  throw new SlugTakenError(context.slug, cause);
}

/**
 * Idempotently ensures a Pages project named `slug` exists for this account:
 * confirms it via GET first, creates it (production_branch: 'main') only if
 * missing. `cloudflareFetchFn` is injectable for tests; real callers never
 * pass it.
 */
export async function ensureProject({ slug, apiToken, accountId, cloudflareFetchFn = cloudflareFetch }) {
  const context = { slug, apiToken, accountId, cloudflareFetchFn };
  const existing = await getProject(context);
  if (existing) return existing;

  try {
    return await createProject(context);
  } catch (error) {
    if (!isCloudflareApiFailure(error)) throw error;
    if (error.cloudflareErrorCode === SLUG_TAKEN_CODE) return resolveSlugTakenConflict(context, error);
    throw new ProjectCreateError(error);
  }
}
