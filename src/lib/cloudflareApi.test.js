import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { cloudflareFetch, verifyToken, CloudflareApiError, CloudflareHttpError } from './cloudflareApi.js';

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchOnce({ ok = true, status = 200, statusText = 'OK', body }) {
  globalThis.fetch = async () => ({ ok, status, statusText, json: async () => body });
}

test('cloudflareFetch unwraps result on a success envelope', async () => {
  mockFetchOnce({ body: { success: true, errors: [], result: { id: 'abc' } } });
  const result = await cloudflareFetch('/user/tokens/verify', { apiToken: 'token' });
  assert.deepEqual(result, { id: 'abc' });
});

test('cloudflareFetch throws CloudflareApiError on a success:false envelope', async () => {
  mockFetchOnce({ body: { success: false, errors: [{ code: 1000, message: 'invalid token' }], result: null } });
  await assert.rejects(
    () => cloudflareFetch('/user/tokens/verify', { apiToken: 'token' }),
    (error) => error instanceof CloudflareApiError && /invalid token/.test(error.message),
  );
});

test('cloudflareFetch throws CloudflareHttpError on a non-2xx response, distinct from CloudflareApiError', async () => {
  mockFetchOnce({ ok: false, status: 500, statusText: 'Internal Server Error', body: { success: false, errors: [] } });
  await assert.rejects(
    () => cloudflareFetch('/user/tokens/verify', { apiToken: 'token' }),
    (error) => error instanceof CloudflareHttpError && !(error instanceof CloudflareApiError),
  );
});

test('cloudflareFetch throws CloudflareHttpError, not a raw SyntaxError, on a non-JSON 5xx body', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    statusText: 'Bad Gateway',
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  });
  await assert.rejects(
    () => cloudflareFetch('/user/tokens/verify', { apiToken: 'token' }),
    (error) => error instanceof CloudflareHttpError && !(error instanceof SyntaxError),
  );
});

test('cloudflareFetch attaches the parsed errors array and Cloudflare error code to CloudflareHttpError', async () => {
  mockFetchOnce({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    body: { success: false, errors: [{ code: 8000003, message: 'slug already exists' }] },
  });
  await assert.rejects(
    () => cloudflareFetch('/accounts/acc/pages/projects/my-app', { apiToken: 'token' }),
    (error) =>
      error instanceof CloudflareHttpError &&
      error.status === 404 &&
      error.cloudflareErrorCode === 8000003 &&
      error.errors[0].message === 'slug already exists',
  );
});

test('verifyToken calls the token verify endpoint and returns its result', async () => {
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ success: true, errors: [], result: { id: 'abc', status: 'active' } }),
    };
  };
  const result = await verifyToken({ apiToken: 'token' });
  assert.equal(result.status, 'active');
  assert.match(requestedUrl, /\/user\/tokens\/verify$/);
});
