// Same rule as src/lib/validate.js: a slug is one DNS label, so a host with
// more labels (a.b.web-express.com.ar) is never a demo.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$|^[a-z0-9]$/;
const SHARD_PATTERN = /^wx-demos-\d{2}$/;
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

export function upstreamUrl(shard, slug, url) {
  return `${shardOrigin(shard)}/${slug}${url.pathname}${url.search}`;
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
export function publicLocation(location, { shard, slug, publicOrigin }) {
  if (!location) return location;
  const prefix = `/${slug}`;
  const shardPrefix = `${shardOrigin(shard)}${prefix}`;
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
