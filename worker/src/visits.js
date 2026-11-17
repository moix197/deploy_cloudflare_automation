import { isOwnerRequest } from './owner.js';
import { classifyVisitor, visitorKey, visitSource } from './visitor.js';

// A repeat page view by the same visitor inside this window is not a new visit.
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;
// Long enough for the page's own assets to follow; a later asset is not this visit's.
const MARKER_TTL_S = 120;

// One statement (dedupe included) so a visit costs at most one D1 row written and no extra read.
const INSERT_VISIT_SQL = `INSERT INTO demo_visits
  (slug, lead_id, at, source, path, country, asn, ua_class, is_owner, visitor_key)
  SELECT ?, (SELECT lead_id FROM demo_placements WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM demo_visits WHERE slug = ? AND visitor_key = ? AND at > ?)`;

const MARK_ASSET_LOADED_SQL = `UPDATE demo_visits SET asset_loaded = 1
  WHERE slug = ? AND visitor_key = ? AND asset_loaded = 0 AND at > ?`;

function markerKey(baseDomain, slug, key) {
  return `https://${baseDomain}/__visit-marker/${slug}/${key}`;
}

function dedupeCutoff(now) {
  return new Date(now.getTime() - DEDUPE_WINDOW_MS).toISOString();
}

/**
 * 'page' (recordable view), 'asset' (anything else served), or null (not tracked).
 * Pages answers a revalidated HTML page with a bare 304 (no Content-Type), so a
 * repeat view in the same browser is recognized by the request's Sec-Fetch-Dest.
 */
function responseKind(request, response) {
  if (response.status === 304 && request.headers.get('Sec-Fetch-Dest') === 'document') return 'page';
  if (response.status !== 200 && response.status !== 304) return null;
  const isHtml = (response.headers.get('Content-Type') ?? '').toLowerCase().startsWith('text/html');
  if (isHtml) return response.status === 200 ? 'page' : null;
  return 'asset';
}

function requestVisitorKey(request, salt) {
  return visitorKey({ salt, ip: request.headers.get('CF-Connecting-IP') ?? '', ua: request.headers.get('User-Agent') ?? '' });
}

async function describeVisit(request, url, env) {
  const ua = request.headers.get('User-Agent') ?? '';
  const asn = request.cf?.asn ?? null;
  return {
    key: await requestVisitorKey(request, env.VISIT_SALT),
    source: visitSource(url),
    path: url.pathname,
    country: request.cf?.country ?? null,
    asn,
    uaClass: classifyVisitor({ ua, asn }),
    isOwner: (await isOwnerRequest(request, env.OWNER_LINK_SECRET)) ? 1 : 0,
  };
}

async function recordPageVisit({ request, url, slug, env, cache, now }) {
  const v = await describeVisit(request, url, env);
  const result = await env.DB.prepare(INSERT_VISIT_SQL).bind(
    slug, slug, now.toISOString(), v.source, v.path, v.country, v.asn, v.uaClass, v.isOwner, v.key,
    slug, v.key, dedupeCutoff(now),
  ).run();
  if (!result?.meta?.changes) return;
  const marker = new Response('', { headers: { 'Cache-Control': `max-age=${MARKER_TTL_S}` } });
  await cache.put(markerKey(env.DEMO_BASE_DOMAIN, slug, v.key), marker);
}

// Scanners usually fetch only the HTML; a browser follows with assets. The marker
// keeps assets without a recent recorded page view from touching D1 at all.
async function recordAssetLoaded({ request, slug, env, cache, now }) {
  const key = await requestVisitorKey(request, env.VISIT_SALT);
  const marker = markerKey(env.DEMO_BASE_DOMAIN, slug, key);
  if (!(await cache.match(marker))) return;
  await cache.delete(marker);
  await env.DB.prepare(MARK_ASSET_LOADED_SQL).bind(slug, key, dedupeCutoff(now)).run();
}

/**
 * Records a demo page view (GET: 200 text/html, or 304 for a document) or flags that its assets
 * loaded, in ctx.waitUntil. Never throws and never touches the response;
 * skipped entirely without the VISIT_SALT secret.
 */
export function trackVisit({ request, response, url, slug, env, ctx, cache, now = new Date() }) {
  if (request.method !== 'GET' || !env.VISIT_SALT) return;
  const kind = responseKind(request, response);
  if (!kind) return;
  const record = kind === 'page' ? recordPageVisit : recordAssetLoaded;
  ctx.waitUntil(record({ request, url, slug, env, cache, now }).catch(() => {}));
}
