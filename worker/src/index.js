import { demoSlugFromHost, isShardName, PROXIED_METHODS, publicLocation, upstreamUrl } from './routing.js';

const KNOWN_TTL_S = 300;
// Short, so a demo deployed seconds after someone visited its host shows up quickly.
const UNKNOWN_TTL_S = 60;

function cacheKey(baseDomain, slug) {
  return `https://${baseDomain}/__demo-shard/${slug}`;
}

async function lookupShard({ slug, env, ctx, cache }) {
  const key = cacheKey(env.DEMO_BASE_DOMAIN, slug);
  const cached = await cache.match(key);
  if (cached) return (await cached.text()) || null;
  const found = await env.DB.prepare('SELECT shard FROM demo_placements WHERE slug = ?').bind(slug).first('shard');
  const shard = isShardName(found) ? found : null;
  const ttl = shard ? KNOWN_TTL_S : UNKNOWN_TTL_S;
  ctx.waitUntil(cache.put(key, new Response(shard ?? '', { headers: { 'Cache-Control': `max-age=${ttl}` } })));
  return shard;
}

async function proxyToShard(request, { shard, slug, url, fetchFn }) {
  const upstream = await fetchFn(new Request(upstreamUrl(shard, slug, url), { method: request.method, headers: request.headers, redirect: 'manual' }));
  const response = new Response(upstream.body, upstream);
  const location = response.headers.get('Location');
  if (location) response.headers.set('Location', publicLocation(location, { shard, slug, publicOrigin: url.origin }));
  return response;
}

/**
 * `<slug>.<DEMO_BASE_DOMAIN>` → `https://<shard>.pages.dev/<slug><path>`.
 * Any host that is not a placed demo goes on to its origin untouched.
 * `fetchFn`/`cache` are injectable for tests; the Worker runtime passes the real ones.
 */
export async function handleRequest(request, env, ctx, { fetchFn = fetch, cache = caches.default } = {}) {
  const url = new URL(request.url);
  const slug = demoSlugFromHost(url.hostname, env.DEMO_BASE_DOMAIN);
  const shard = slug ? await lookupShard({ slug, env, ctx, cache }) : null;
  if (!shard) return fetchFn(request);
  if (!PROXIED_METHODS.has(request.method)) {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  return proxyToShard(request, { shard, slug, url, fetchFn });
}

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
};
