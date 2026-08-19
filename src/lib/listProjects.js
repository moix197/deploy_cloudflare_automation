import { cloudflareFetch } from './cloudflareApi.js';

function toProjectSummary(project) {
  return {
    name: project.name,
    subdomain: project.subdomain,
    domains: project.domains ?? [],
    productionBranch: project.production_branch,
  };
}

/**
 * Lists every Pages project in the account, mapped to the package's stable
 * `{name, subdomain, domains, productionBranch}` shape rather than
 * Cloudflare's raw project object. `cloudflareFetchFn` is injectable for
 * tests; real callers never pass it.
 */
export async function listProjects({ apiToken, accountId, cloudflareFetchFn = cloudflareFetch }) {
  const projects = await cloudflareFetchFn(`/accounts/${accountId}/pages/projects`, { apiToken });
  return projects.map(toProjectSummary);
}
