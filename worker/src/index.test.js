import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleRequest } from './index.js';
import { demoSlugFromHost, passthroughSubdomains, publicLocation, upstreamOrigin, upstreamUrl } from './routing.js';

const BASE = 'web-express.com.ar';
const DEPLOYMENT = 'https://0123abcd.wx-demos-03.pages.dev';

test('demoSlugFromHost accepts one valid label under the base domain only', () => {
  assert.equal(demoSlugFromHost('bellevue.web-express.com.ar', BASE), 'bellevue');
  assert.equal(demoSlugFromHost('Don-Mario.Web-Express.com.ar.', BASE), 'don-mario');
  assert.equal(demoSlugFromHost('bellevue.web-express.com.ar:443', BASE), 'bellevue');
  assert.equal(demoSlugFromHost('web-express.com.ar', BASE), null);
  assert.equal(demoSlugFromHost('www.web-express.com.ar', BASE), null);
  assert.equal(demoSlugFromHost('a.b.web-express.com.ar', BASE), null);
  assert.equal(demoSlugFromHost('-bad.web-express.com.ar', BASE), null);
  assert.equal(demoSlugFromHost('bellevue.web-express.com.ar.evil.com', BASE), null);
  assert.equal(demoSlugFromHost('xweb-express.com.ar', BASE), null);
});

test('passthroughSubdomains parses the wrangler var and always keeps www', () => {
  assert.deepEqual([...passthroughSubdomains()], ['www']);
  assert.deepEqual([...passthroughSubdomains(' Mail , zmail._domainkey,,')], ['www', 'mail', 'zmail._domainkey']);
  assert.equal(demoSlugFromHost('mail.web-express.com.ar', BASE, passthroughSubdomains('mail')), null);
  assert.equal(demoSlugFromHost('mail.web-express.com.ar', BASE), 'mail');
});

test('upstreamUrl keeps path and query under /<slug>', () => {
  const url = new URL('https://demo.web-express.com.ar/about/?x=1&y=2');
  assert.equal(upstreamUrl(DEPLOYMENT, 'demo', url), `${DEPLOYMENT}/demo/about/?x=1&y=2`);
  assert.equal(upstreamUrl(DEPLOYMENT, 'demo', new URL('https://demo.web-express.com.ar/')), `${DEPLOYMENT}/demo/`);
});

test('upstreamOrigin trusts only a deployment URL of that same shard, else the alias', () => {
  assert.equal(upstreamOrigin('wx-demos-03', DEPLOYMENT), DEPLOYMENT);
  assert.equal(upstreamOrigin('wx-demos-03', null), 'https://wx-demos-03.pages.dev');
  assert.equal(upstreamOrigin('wx-demos-03', 'https://0123abcd.wx-demos-04.pages.dev'), 'https://wx-demos-03.pages.dev');
  assert.equal(upstreamOrigin('wx-demos-03', 'https://0123abcd.wx-demos-03.pages.dev.evil.com'), 'https://wx-demos-03.pages.dev');
  assert.equal(upstreamOrigin('wx-demos-03', 'https://0123abcd.wx-demos-03.pages.dev/x'), 'https://wx-demos-03.pages.dev');
});

test('publicLocation strips the /<slug> prefix from shard redirects only', () => {
  const ctx = { origin: DEPLOYMENT, slug: 'demo', publicOrigin: 'https://demo.web-express.com.ar' };
  assert.equal(publicLocation('/demo/about/', ctx), '/about/');
  assert.equal(publicLocation('/demo', ctx), '/');
  assert.equal(publicLocation('/demo?x=1', ctx), '/?x=1');
  assert.equal(publicLocation(`${DEPLOYMENT}/demo/about/`, ctx), 'https://demo.web-express.com.ar/about/');
  assert.equal(publicLocation('/demo-two/x', ctx), '/demo-two/x');
  assert.equal(publicLocation('https://elsewhere.com/demo/x', ctx), 'https://elsewhere.com/demo/x');
});

/**
 * `placements`: slug → shard, or slug → {shard, url} (url = the shard's deployment URL in D1).
 * `run` answers write statements (recorded in `runs`); default: one row changed.
 */
function fakeEnv(placements, { run = async () => ({ meta: { changes: 1 } }) } = {}) {
  const queries = [];
  const runs = [];
  return {
    queries,
    runs,
    env: {
      DEMO_BASE_DOMAIN: BASE,
      DB: {
        prepare: (sql) => ({
          bind: (...params) => ({
            first: async () => {
              const [slug] = params;
              queries.push({ sql, slug });
              const placement = placements[slug];
              if (!placement) return null;
              return typeof placement === 'string' ? { shard: placement, url: DEPLOYMENT } : placement;
            },
            run: async () => {
              runs.push({ sql, params });
              return run();
            },
          }),
        }),
      },
    },
  };
}

function fakeCache() {
  const entries = new Map();
  return {
    entries,
    match: async (key) => entries.get(key)?.clone(),
    put: async (key, response) => {
      entries.set(key, response);
    },
    delete: async (key) => entries.delete(key),
  };
}

function fakeCtx() {
  const pending = [];
  return { pending, waitUntil: (promise) => pending.push(promise) };
}

function recordingFetch(respond = () => new Response('upstream')) {
  const calls = [];
  const fetchFn = async (request) => {
    calls.push(request);
    return respond(request);
  };
  return { calls, fetchFn };
}

test('a placed demo is proxied to its shard path and the lookup is cached', async () => {
  const { env, queries } = fakeEnv({ demo: 'wx-demos-03' });
  const cache = fakeCache();
  const { calls, fetchFn } = recordingFetch();
  for (let i = 0; i < 2; i += 1) {
    const ctx = fakeCtx();
    const response = await handleRequest(new Request('https://demo.web-express.com.ar/img/a.webp?v=2'), env, ctx, { fetchFn, cache });
    await Promise.all(ctx.pending);
    assert.equal(await response.text(), 'upstream');
  }
  assert.deepEqual(calls.map((r) => r.url), [`${DEPLOYMENT}/demo/img/a.webp?v=2`, `${DEPLOYMENT}/demo/img/a.webp?v=2`]);
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(queries.length, 1);
  assert.match(cache.entries.values().next().value.headers.get('Cache-Control'), /max-age=15/);
});

test('a shard with no deployment URL in D1 is proxied through its pages.dev alias', async () => {
  const { env } = fakeEnv({ demo: { shard: 'wx-demos-03', url: null } });
  const { calls, fetchFn } = recordingFetch();
  await handleRequest(new Request('https://demo.web-express.com.ar/x'), env, fakeCtx(), { fetchFn, cache: fakeCache() });
  assert.equal(calls[0].url, 'https://wx-demos-03.pages.dev/demo/x');
});

test('shard redirects come back with the public path', async () => {
  const { env } = fakeEnv({ demo: 'wx-demos-03' });
  const { fetchFn } = recordingFetch(() => new Response(null, { status: 308, headers: { Location: '/demo/about/' } }));
  const response = await handleRequest(new Request('https://demo.web-express.com.ar/about'), env, fakeCtx(), { fetchFn, cache: fakeCache() });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('Location'), '/about/');
});

test('an unknown demo host gets the branded 404 page and the miss is cached', async () => {
  const { env, queries } = fakeEnv({});
  const { calls, fetchFn } = recordingFetch();
  const cache = fakeCache();
  const ctx = fakeCtx();
  const response = await handleRequest(new Request('https://nobody.web-express.com.ar/x'), env, ctx, { fetchFn, cache });
  await Promise.all(ctx.pending);
  assert.equal(response.status, 404);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  assert.match(await response.text(), /Demo no encontrada/);
  const head = await handleRequest(new Request('https://nobody.web-express.com.ar/', { method: 'HEAD' }), env, fakeCtx(), { fetchFn, cache });
  assert.equal(head.status, 404);
  assert.equal(calls.length, 0);
  assert.equal(queries.length, 1);
  assert.match(cache.entries.values().next().value.headers.get('Cache-Control'), /max-age=60/);
});

test('the apex, www, PASSTHROUGH_SUBDOMAINS and non-slug hosts pass through without D1', async () => {
  const { env, queries } = fakeEnv({});
  env.PASSTHROUGH_SUBDOMAINS = 'mail';
  const { calls, fetchFn } = recordingFetch(() => new Response('origin'));
  const hosts = ['web-express.com.ar', 'www.web-express.com.ar', 'mail.web-express.com.ar', 'zmail._domainkey.web-express.com.ar', 'other.com'];
  for (const host of hosts) {
    const response = await handleRequest(new Request(`https://${host}/`), env, fakeCtx(), { fetchFn, cache: fakeCache() });
    assert.equal(await response.text(), 'origin', host);
  }
  assert.equal(calls.length, hosts.length);
  assert.equal(queries.length, 0);
});

test('a malformed shard value in D1 is treated as unknown (404, never proxied)', async () => {
  const { env } = fakeEnv({ demo: { shard: 'evil.example.com', url: null } });
  const { calls, fetchFn } = recordingFetch();
  const response = await handleRequest(new Request('https://demo.web-express.com.ar/'), env, fakeCtx(), { fetchFn, cache: fakeCache() });
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});

test('non-GET/HEAD requests to a demo get 405 and never reach the shard', async () => {
  const { env } = fakeEnv({ demo: 'wx-demos-03' });
  const { calls, fetchFn } = recordingFetch();
  const response = await handleRequest(new Request('https://demo.web-express.com.ar/form', { method: 'POST', body: 'x' }), env, fakeCtx(), { fetchFn, cache: fakeCache() });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET, HEAD');
  assert.equal(calls.length, 0);
});

test('a D1 lookup failure passes the request through and is not cached', async () => {
  const { env } = fakeEnv({});
  env.DB = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('d1 down'); } }) }) };
  const cache = fakeCache();
  const ctx = fakeCtx();
  const { calls, fetchFn } = recordingFetch();
  const request = new Request('https://demo.web-express.com.ar/');
  await handleRequest(request, env, ctx, { fetchFn, cache });
  assert.equal(calls[0], request);
  assert.equal(ctx.pending.length, 0);
  assert.equal(cache.entries.size, 0);
});

test('a shard 404 is replaced by the demo 404.html (status stays 404) when it exists', async () => {
  const { env } = fakeEnv({ demo: 'wx-demos-03' });
  const { calls, fetchFn } = recordingFetch((request) =>
    request.url.endsWith('/demo/404.html') ? new Response('custom', { status: 200, headers: { 'Content-Type': 'text/html' } }) : new Response('pages 404', { status: 404 }));
  const response = await handleRequest(new Request('https://demo.web-express.com.ar/nope'), env, fakeCtx(), { fetchFn, cache: fakeCache() });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'custom');
  assert.equal(response.headers.get('Content-Type'), 'text/html');
  assert.deepEqual(calls.map((r) => r.url), [`${DEPLOYMENT}/demo/nope`, `${DEPLOYMENT}/demo/404.html`]);
});

test('a shard 404 stays as is when the demo has no 404.html', async () => {
  const { env } = fakeEnv({ demo: 'wx-demos-03' });
  const { fetchFn } = recordingFetch(() => new Response('pages 404', { status: 404 }));
  const response = await handleRequest(new Request('https://demo.web-express.com.ar/nope'), env, fakeCtx(), { fetchFn, cache: fakeCache() });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'pages 404');
});

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const OWNER_SECRET = 'owner-secret';

function trackingEnv(options) {
  const fake = fakeEnv({ demo: 'wx-demos-03' }, options);
  Object.assign(fake.env, { VISIT_SALT: 'salt', OWNER_LINK_SECRET: OWNER_SECRET });
  return fake;
}

function demoRequest(path, headers = {}) {
  return new Request(`https://demo.web-express.com.ar${path}`, {
    headers: { 'User-Agent': CHROME_UA, 'CF-Connecting-IP': '203.0.113.7', ...headers },
  });
}

/** Shard serving HTML for `/` and `/about/`, anything else as an image. */
function shardFetch() {
  return recordingFetch((request) => {
    const isPage = /\/demo\/(about\/)?$/.test(new URL(request.url).pathname);
    return new Response('body', { headers: { 'Content-Type': isPage ? 'text/html; charset=utf-8' : 'image/webp' } });
  });
}

async function serve(request, env, { fetchFn = shardFetch().fetchFn, cache = fakeCache() } = {}) {
  const ctx = fakeCtx();
  const response = await handleRequest(request, env, ctx, { fetchFn, cache });
  await Promise.all(ctx.pending);
  return response;
}

const isInsert = (run) => run.sql.startsWith('INSERT INTO demo_visits');
const isUpdate = (run) => run.sql.startsWith('UPDATE demo_visits');

test('an HTML page view records one deduped INSERT with the visit fields', async () => {
  const { env, runs } = trackingEnv();
  const response = await serve(demoRequest('/about/?e=1'), env);
  assert.equal(await response.text(), 'body');
  assert.equal(runs.length, 1);
  assert.ok(isInsert(runs[0]));
  assert.match(runs[0].sql, /WHERE NOT EXISTS \(SELECT 1 FROM demo_visits WHERE slug = \? AND visitor_key = \? AND at > \?\)/);
  const [slug, leadSlug, at, source, path, country, asn, uaClass, isOwner, key, dedupeSlug, dedupeKey, cutoff] = runs[0].params;
  assert.deepEqual([slug, leadSlug, source, path, country, asn, uaClass, isOwner], ['demo', 'demo', 'email', '/about/', null, null, 'browser', 0]);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.deepEqual([dedupeSlug, dedupeKey], ['demo', key]);
  assert.equal(Date.parse(at) - Date.parse(cutoff), 30 * 60 * 1000);
  assert.ok(!JSON.stringify(runs[0].params).includes('203.0.113.7'));
});

test('assets, HEAD, non-200 pages and a missing VISIT_SALT record nothing', async () => {
  const { env, runs } = trackingEnv();
  await serve(demoRequest('/img/a.webp'), env);
  await serve(new Request('https://demo.web-express.com.ar/', { method: 'HEAD' }), env);
  const { fetchFn } = recordingFetch(() => new Response('gone', { status: 404, headers: { 'Content-Type': 'text/html' } }));
  await serve(demoRequest('/nope'), env, { fetchFn });
  delete env.VISIT_SALT;
  await serve(demoRequest('/'), env);
  assert.equal(runs.length, 0);
});

test('a throwing D1 write still serves the page untouched', async () => {
  const { env } = trackingEnv({ run: async () => { throw new Error('d1 down'); } });
  const response = await serve(demoRequest('/'), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'body');
});

test('the owner link sets the owner cookie; a wrong or missing key falls through unchanged', async () => {
  const { env, runs } = trackingEnv();
  const { calls, fetchFn } = shardFetch();
  const owner = await serve(demoRequest(`/__wx-owner?k=${OWNER_SECRET}`), env, { fetchFn });
  assert.equal(owner.status, 200);
  assert.equal(owner.headers.get('Cache-Control'), 'no-store');
  assert.match(await owner.text(), /Owner mode on/);
  assert.match(owner.headers.get('Set-Cookie'),
    /^wx_owner=[0-9a-f]{64}; Domain=\.web-express\.com\.ar; Path=\/; Max-Age=34560000; Secure; HttpOnly; SameSite=Lax$/);
  assert.equal(calls.length, 0);
  assert.equal(runs.length, 0);
  for (const path of ['/__wx-owner?k=wrong', '/__wx-owner']) {
    const response = await serve(demoRequest(path), env, { fetchFn });
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal(calls.at(-1).url, `${DEPLOYMENT}/demo${path}`);
  }
  delete env.OWNER_LINK_SECRET;
  const noSecret = await serve(demoRequest('/__wx-owner?k=undefined'), env, { fetchFn });
  assert.equal(noSecret.headers.get('Set-Cookie'), null);
});

test('the owner cookie marks the visit is_owner = 1', async () => {
  const { env, runs } = trackingEnv();
  const owner = await serve(demoRequest(`/__wx-owner?k=${OWNER_SECRET}`), env);
  const cookie = owner.headers.get('Set-Cookie').split(';')[0];
  await serve(demoRequest('/', { Cookie: `theme=dark; ${cookie}` }), env);
  await serve(demoRequest('/', { Cookie: 'wx_owner=forged', 'CF-Connecting-IP': '198.51.100.1' }), env);
  assert.deepEqual(runs.map((run) => run.params[8]), [1, 0]);
});

test('an asset after a recorded page view runs the single asset_loaded UPDATE once', async () => {
  const { env, runs } = trackingEnv();
  const cache = fakeCache();
  await serve(demoRequest('/'), env, { cache });
  await serve(demoRequest('/img/a.webp'), env, { cache });
  await serve(demoRequest('/img/b.webp'), env, { cache });
  await serve(demoRequest('/img/a.webp', { 'CF-Connecting-IP': '198.51.100.1' }), env, { cache });
  assert.deepEqual(runs.map((run) => (isInsert(run) ? 'insert' : isUpdate(run) && 'update')), ['insert', 'update']);
  const [slug, key, cutoff] = runs[1].params;
  assert.deepEqual([slug, key], ['demo', runs[0].params[9]]);
  assert.match(runs[1].sql, /SET asset_loaded = 1\s+WHERE slug = \? AND visitor_key = \? AND asset_loaded = 0 AND at > \?/);
  assert.ok(Date.parse(cutoff) < Date.parse(runs[0].params[2]));
});

test('a 304 for a document is a page view; a 304 for anything else is only an asset', async () => {
  const notModified = recordingFetch(() => new Response(null, { status: 304 })).fetchFn;
  const { env, runs } = trackingEnv();
  const cache = fakeCache();
  const response = await serve(demoRequest('/?e=1', { 'Sec-Fetch-Dest': 'document' }), env, { fetchFn: notModified, cache });
  assert.equal(response.status, 304);
  await serve(demoRequest('/img/a.webp', { 'Sec-Fetch-Dest': 'image' }), env, { fetchFn: notModified, cache });
  assert.deepEqual(runs.map((run) => (isInsert(run) ? 'insert' : isUpdate(run) && 'update')), ['insert', 'update']);
  assert.deepEqual([runs[0].params[3], runs[0].params[4]], ['email', '/']);

  const { env: noDest, runs: noDestRuns } = trackingEnv();
  await serve(demoRequest('/'), noDest, { fetchFn: notModified });
  await serve(demoRequest('/img/a.webp', { 'Sec-Fetch-Dest': 'image' }), noDest, { fetchFn: notModified });
  assert.equal(noDestRuns.length, 0);
});

test('a deduped page view (no row inserted) leaves no asset marker', async () => {
  const { env, runs } = trackingEnv({ run: async () => ({ meta: { changes: 0 } }) });
  const cache = fakeCache();
  await serve(demoRequest('/'), env, { cache });
  await serve(demoRequest('/img/a.webp'), env, { cache });
  assert.equal(runs.filter(isUpdate).length, 0);
});
