import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ensureProject } from './ensureProject.js';
import { CloudflareApiError, CloudflareHttpError } from './cloudflareApi.js';
import { ProjectCreateError, SlugTakenError } from '../errors.js';

const CONTEXT = { slug: 'my-app', apiToken: 'token', accountId: 'acc' };

test('creates the project when a GET for the slug 404s', async () => {
  let createCalled = false;
  const cloudflareFetchFn = async (path, { method = 'GET' } = {}) => {
    if (method === 'GET') throw new CloudflareHttpError(404, 'Not Found', [{ code: 8000007, message: 'not found' }]);
    createCalled = true;
    return { name: 'my-app', subdomain: 'my-app.pages.dev' };
  };
  const result = await ensureProject({ ...CONTEXT, cloudflareFetchFn });
  assert.equal(createCalled, true);
  assert.equal(result.subdomain, 'my-app.pages.dev');
});

test('skips create when the project already exists for this account', async () => {
  let createCalled = false;
  const cloudflareFetchFn = async (path, { method = 'GET' } = {}) => {
    if (method === 'GET') return { name: 'my-app', subdomain: 'my-app.pages.dev' };
    createCalled = true;
    return {};
  };
  const result = await ensureProject({ ...CONTEXT, cloudflareFetchFn });
  assert.equal(createCalled, false);
  assert.equal(result.subdomain, 'my-app.pages.dev');
});

test('resolves without throwing when create races a concurrent same-account create', async () => {
  let getCallCount = 0;
  const cloudflareFetchFn = async (path, { method = 'GET' } = {}) => {
    if (method === 'GET') {
      getCallCount += 1;
      if (getCallCount === 1) throw new CloudflareHttpError(404, 'Not Found');
      return { name: 'my-app', subdomain: 'my-app.pages.dev' };
    }
    throw new CloudflareApiError([{ code: 8000003, message: 'already exists' }]);
  };
  const result = await ensureProject({ ...CONTEXT, cloudflareFetchFn });
  assert.equal(result.subdomain, 'my-app.pages.dev');
  assert.equal(getCallCount, 2);
});

test('throws SlugTakenError when the create-fails re-GET still finds nothing (taken by someone else)', async () => {
  const cloudflareFetchFn = async (path, { method = 'GET' } = {}) => {
    if (method === 'GET') throw new CloudflareHttpError(404, 'Not Found');
    throw new CloudflareApiError([{ code: 8000003, message: 'already exists' }]);
  };
  await assert.rejects(
    () => ensureProject({ ...CONTEXT, cloudflareFetchFn }),
    (error) => error instanceof SlugTakenError && error.slug === 'my-app',
  );
});

test('throws ProjectCreateError carrying the original code/message for any other create failure', async () => {
  const cloudflareFetchFn = async (path, { method = 'GET' } = {}) => {
    if (method === 'GET') throw new CloudflareHttpError(404, 'Not Found');
    throw new CloudflareApiError([{ code: 8000013, message: 'too many projects for this account' }]);
  };
  await assert.rejects(
    () => ensureProject({ ...CONTEXT, cloudflareFetchFn }),
    (error) =>
      error instanceof ProjectCreateError &&
      !(error instanceof SlugTakenError) &&
      error.cloudflareErrorCode === 8000013 &&
      /too many projects/.test(error.message),
  );
});

test('propagates a non-Cloudflare failure from create unchanged', async () => {
  const transportError = new Error('network down');
  const cloudflareFetchFn = async (path, { method = 'GET' } = {}) => {
    if (method === 'GET') throw new CloudflareHttpError(404, 'Not Found');
    throw transportError;
  };
  await assert.rejects(() => ensureProject({ ...CONTEXT, cloudflareFetchFn }), (error) => error === transportError);
});
