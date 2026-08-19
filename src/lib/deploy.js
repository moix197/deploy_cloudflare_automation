import { resolve as resolvePath } from 'node:path';

import { resolveAuth } from '../auth/resolveAuth.js';
import { cloudflareFetch } from './cloudflareApi.js';
import { ensureProject } from './ensureProject.js';
import { runWrangler } from './runWrangler.js';
import { validateDir, validateSlug } from './validate.js';

function noop() {}

/**
 * Reads the authoritative live hostname back from Cloudflare rather than
 * assuming `<slug>.pages.dev` — see
 * .ai/decisions/hostname-read-back-not-constructed.md.
 */
async function readProjectSubdomain({ slug, apiToken, accountId, cloudflareFetchFn = cloudflareFetch }) {
  const project = await cloudflareFetchFn(`/accounts/${accountId}/pages/projects/${slug}`, { apiToken });
  return project.subdomain;
}

/**
 * Publishes `dir` to Cloudflare Pages under `slug`: ensures the project
 * exists (creating it if missing), uploads via wrangler, then reads the real
 * live URL back from the API. `resolveAuth()` runs exactly once — the same
 * `{apiToken, accountId}` reaches both `ensureProject` and `runWrangler`, so
 * there is a single credential-resolution path. A `RateLimitError` from the
 * upload propagates straight to the caller; there is no auto-retry (see
 * Dependencies & Risks in the plan). `ensureProjectFn`/`runWranglerFn`/
 * `readProjectSubdomainFn`/`resolveAuthFn` are injectable for tests.
 */
export async function deploy({
  dir,
  slug,
  onStart = noop,
  onProgress = noop,
  onDone = noop,
  onError = noop,
  resolveAuthFn = resolveAuth,
  ensureProjectFn = ensureProject,
  runWranglerFn = runWrangler,
  readProjectSubdomainFn = readProjectSubdomain,
} = {}) {
  try {
    const { apiToken, accountId } = resolveAuthFn();
    validateSlug(slug);
    const absoluteDir = resolvePath(validateDir(dir));

    onStart({ slug, dir: absoluteDir });
    await ensureProjectFn({ slug, apiToken, accountId });

    onProgress('uploading');
    await runWranglerFn(
      ['pages', 'deploy', absoluteDir, '--project-name', slug, '--branch', 'main', '--commit-dirty=true'],
      { apiToken, accountId },
    );

    const subdomain = await readProjectSubdomainFn({ slug, apiToken, accountId });
    const result = { url: `https://${subdomain}`, slug, projectName: slug, status: 'deployed' };
    onDone(result);
    return result;
  } catch (error) {
    onError(error);
    throw error;
  }
}
