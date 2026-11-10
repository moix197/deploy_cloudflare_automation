import { demoNotFound } from './notFound.js';
import {
  demoSlugFromHost, isShardName, passthroughSubdomains, PROXIED_METHODS, publicLocation, upstreamOrigin, upstreamUrl,
} from './routing.js';

// Short: the cached origin names a deployment, so a redeploy/delete shows once it expires.
const KNOWN_TTL_S = 15;
// Short, so a demo deployed seconds after someone visited its host shows up quickly.
const UNKNOWN_TTL_S = 60;

function cacheKey(baseDomain, slug) {
  return `https://${baseDomain}/__demo-origin/${slug}`;
}

const LOOKUP_SQL = `SELECT p.shard, d.url FROM demo_placements p
  LEFT JOIN shard_deployments d ON d.shard = p.shard WHERE p.slug = ?`;

/** slug → origin serving `/<slug>/` (the shard's latest deployment), or null. */
async function lookupOrigin({ slug, env, ctx, cache }) {
  const key = cacheKey(env.DEMO_BASE_DOMAIN, slug);
  const cached = await cache.match(key);
  if (cached) return (await cached.text()) || null;
  const row = await env.DB.prepare(LOOKUP_SQL).bind(slug).first();
  const origin = isShardName(row?.shard) ? upstreamOrigin(row.shard, row.url) : null;
  const ttl = origin ? KNOWN_TTL_S : UNKNOWN_TTL_S;
  ctx.waitUntil(cache.put(key, new Response(origin ?? '', { headers: { 'Cache-Control': `max-age=${ttl}` } })));
  return origin;
}

function fetchUpstream(request, upstream, fetchFn, redirect = 'manual') {
  return fetchFn(new Request(upstream, { method: request.method, headers: request.headers, redirect }));
}

/**
 * Pages serves its own 404 for unknown paths; a demo's `/<slug>/404.html` replaces it when present.
 * Follows redirects because Pages rewrites `/404.html` to `/404`.
 */
async function customNotFound(request, { origin, slug, url, fetchFn }) {
  const page = await fetchUpstream(request, upstreamUrl(origin, slug, new URL('/404.html', url)), fetchFn, 'follow');
  return page.status === 200 ? new Response(page.body, { status: 404, headers: page.headers }) : null;
}

async function proxyToShard(request, { origin, slug, url, fetchFn }) {
  const upstream = await fetchUpstream(request, upstreamUrl(origin, slug, url), fetchFn);
  if (upstream.status === 404) {
    const notFound = await customNotFound(request, { origin, slug, url, fetchFn });
    if (notFound) return notFound;
  }
  const response = new Response(upstream.body, upstream);
  const location = response.headers.get('Location');
  if (location) response.headers.set('Location', publicLocation(location, { origin, slug, publicOrigin: url.origin }));
  return response;
}

/**
 * `<slug>.<DEMO_BASE_DOMAIN>` → `<shard's latest deployment URL>/<slug><path>`.
 * A slug with no placement gets the branded 404. The apex, PASSTHROUGH_SUBDOMAINS
 * and non-slug hosts go on to their origin untouched, and so does any host when
 * the D1 lookup fails (a D1 outage must not turn every demo into a 404).
 * `fetchFn`/`cache` are injectable for tests; the Worker runtime passes the real ones.
 */
export async function handleRequest(request, env, ctx, { fetchFn = fetch, cache = caches.default } = {}) {
  const url = new URL(request.url);
  const slug = demoSlugFromHost(url.hostname, env.DEMO_BASE_DOMAIN, passthroughSubdomains(env.PASSTHROUGH_SUBDOMAINS));
  if (!slug) return fetchFn(request);
  let origin;
  try {
    origin = await lookupOrigin({ slug, env, ctx, cache });
  } catch {
    return fetchFn(request);
  }
  if (!origin) return demoNotFound(request, env.DEMO_BASE_DOMAIN);
  if (!PROXIED_METHODS.has(request.method)) {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  return proxyToShard(request, { origin, slug, url, fetchFn });
}

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
};
