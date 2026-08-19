import { cloudflareFetch } from './cloudflareApi.js';
import { resolveAuth } from '../auth/resolveAuth.js';

// Cloudflare paginates this endpoint; an account near the documented
// 100-project cap needs more than one page. `cloudflareFetch` only returns
// the unwrapped `result` array (see cloudflareApi.js), not the envelope's
// `result_info`, so "more pages exist" is inferred from a full page coming
// back rather than read off `result_info` directly: a page with fewer than
// `PROJECTS_PER_PAGE` results is necessarily the last one.
//
// 10, not the 25/100 you'd expect from other Cloudflare list endpoints:
// confirmed live against this endpoint that `per_page=25` and `per_page=100`
// both fail with Cloudflare error 8000024 ("Invalid list options provided"),
// while `per_page=10` succeeds — undocumented, so verified empirically
// rather than assumed.
const PROJECTS_PER_PAGE = 10;

// Defensive cap, not a real limit: the documented 100-project account cap
// means a fully-populated account never exceeds 10 pages at
// PROJECTS_PER_PAGE=10. A mocked (or malfunctioning) API that ignores `page`
// and returns a full page forever would otherwise loop unbounded, growing
// memory without limit — this stops that cleanly instead of hanging.
const MAX_PAGES = 20;

function toProjectSummary(project) {
  return {
    name: project.name,
    subdomain: project.subdomain,
    domains: project.domains ?? [],
    productionBranch: project.production_branch,
  };
}

async function fetchAllProjectPages({ apiToken, accountId, cloudflareFetchFn }) {
  const allProjects = [];
  let page = 1;
  let pageOfProjects;
  do {
    pageOfProjects = await cloudflareFetchFn(
      `/accounts/${encodeURIComponent(accountId)}/pages/projects?page=${page}&per_page=${PROJECTS_PER_PAGE}`,
      { apiToken },
    );
    allProjects.push(...(pageOfProjects ?? []));
    page += 1;
  } while (pageOfProjects?.length === PROJECTS_PER_PAGE && page <= MAX_PAGES);
  return allProjects;
}

/**
 * Lists every Pages project in the account, mapped to the package's stable
 * `{name, subdomain, domains, productionBranch}` shape rather than
 * Cloudflare's raw project object. Self-resolves `{apiToken, accountId}` the
 * same way `deploy()` does when the caller doesn't supply them (explicit
 * args still win — see `resolveAuth`'s precedence). `cloudflareFetchFn`/
 * `resolveAuthFn` are injectable for tests; real callers never pass them.
 */
export async function listProjects({ apiToken, accountId, cloudflareFetchFn = cloudflareFetch, resolveAuthFn = resolveAuth } = {}) {
  ({ apiToken, accountId } = resolveAuthFn({ apiToken, accountId }));
  const projects = await fetchAllProjectPages({ apiToken, accountId, cloudflareFetchFn });
  return projects.map(toProjectSummary);
}
