// Same rule as src/lib/validate.js: a slug is one DNS label, so a host with
// more labels (a.b.web-express.com.ar) is never a demo.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$|^[a-z0-9]$/;
const SHARD_PATTERN = /^wx-demos-\d{2}$/;
const DEPLOYMENT_URL_PATTERN = /^https:\/\/[0-9a-f]{8}\.([a-z0-9-]+)\.pages\.dev$/;
const NOT_DEMOS = new Set(['www']);

export const PROXIED_METHODS = new Set(['GET', 'HEAD']);

/** `<slug>.<baseDomain>` → slug; anything else → null. */
export function demoSlugFromHost(host, baseDomain) {
  const name = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  return SLUG_PATTERN.test(label) && !NOT_DEMOS.has(label) ? label : null;
}

export function isShardName(value) {
  return typeof value === 'string' && SHARD_PATTERN.test(value);
}

export function shardOrigin(shard) {
  return `https://${shard}.pages.dev`;
}

/**
 * The shard's latest deployment URL (`https://<id8>.<shard>.pages.dev`) is
 * immutable, so nothing cached for it can go stale; the alias is only the
 * fallback when D1 has no (valid) deployment URL for the shard.
 */
export function upstreamOrigin(shard, deploymentUrl) {
  const valid = typeof deploymentUrl === 'string' && DEPLOYMENT_URL_PATTERN.exec(deploymentUrl)?.[1] === shard;
  return valid ? deploymentUrl : shardOrigin(shard);
}

export function upstreamUrl(origin, slug, url) {
  return `${origin}/${slug}${url.pathname}${url.search}`;
}

// The part of a location after `/<slug>`, as a root-relative path; null when
// the match was only a longer slug sharing the prefix (`/slug-two/...`).
function pathAfterSlug(rest) {
  if (rest === '') return '/';
  if (rest[0] === '/') return rest;
  if (rest[0] === '?' || rest[0] === '#') return `/${rest}`;
  return null;
}

/**
 * Pages redirects inside the shard (`/slug/about` → `/slug/about/`, `.html`
 * stripping) carry the `/<slug>` prefix; the visitor must see the path
 * without it on their own host.
 */
export function publicLocation(location, { origin, slug, publicOrigin }) {
  if (!location) return location;
  const prefix = `/${slug}`;
  const shardPrefix = `${origin}${prefix}`;
  if (location.startsWith(shardPrefix)) {
    const rest = pathAfterSlug(location.slice(shardPrefix.length));
    if (rest !== null) return `${publicOrigin}${rest}`;
  }
  if (location.startsWith(prefix)) {
    const rest = pathAfterSlug(location.slice(prefix.length));
    if (rest !== null) return rest;
  }
  return location;
}
