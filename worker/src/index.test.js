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

/** `placements`: slug → shard, or slug → {shard, url} (url = the shard's deployment URL in D1). */
function fakeEnv(placements) {
  const queries = [];
  return {
    queries,
    env: {
      DEMO_BASE_DOMAIN: BASE,
      DB: {
        prepare: (sql) => ({
          bind: (slug) => ({
            first: async () => {
              queries.push({ sql, slug });
              const placement = placements[slug];
              if (!placement) return null;
              return typeof placement === 'string' ? { shard: placement, url: DEPLOYMENT } : placement;
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
