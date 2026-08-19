import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deleteProject } from './deleteProject.js';
import { CloudflareHttpError } from './cloudflareApi.js';
import { InvalidSlugError, ProjectNotFoundError } from '../errors.js';

const CONTEXT = { slug: 'my-app', apiToken: 'token', accountId: 'acc' };

test('resolves with a deleted status on a successful delete', async () => {
  let calledWith;
  const cloudflareFetchFn = async (path, opts) => {
    calledWith = { path, opts };
    return {};
  };
  const result = await deleteProject({ ...CONTEXT, cloudflareFetchFn });
  assert.deepEqual(result, { slug: 'my-app', status: 'deleted' });
  assert.equal(calledWith.path, '/accounts/acc/pages/projects/my-app');
  assert.equal(calledWith.opts.method, 'DELETE');
});

test('throws ProjectNotFoundError, not a raw error, on a 404', async () => {
  const cloudflareFetchFn = async () => {
    throw new CloudflareHttpError(404, 'Not Found', [{ code: 8000007, message: 'not found' }]);
  };
  await assert.rejects(
    () => deleteProject({ ...CONTEXT, cloudflareFetchFn }),
    (error) => error instanceof ProjectNotFoundError && error.slug === 'my-app',
  );
});

test('propagates a non-404 failure unchanged', async () => {
  const cloudflareFetchFn = async () => {
    throw new CloudflareHttpError(500, 'Internal Server Error');
  };
  await assert.rejects(
    () => deleteProject({ ...CONTEXT, cloudflareFetchFn }),
    (error) => error instanceof CloudflareHttpError && !(error instanceof ProjectNotFoundError),
  );
});

test('rejects a path-traversal slug without ever calling the network', async () => {
  const traversalSlugs = ['..', '', 'a/../b', 'my/app'];
  for (const slug of traversalSlugs) {
    let fetchCalled = false;
    const cloudflareFetchFn = async () => {
      fetchCalled = true;
      return {};
    };
    await assert.rejects(
      () => deleteProject({ ...CONTEXT, slug, cloudflareFetchFn }),
      InvalidSlugError,
      `expected slug ${JSON.stringify(slug)} to be rejected`,
    );
    assert.equal(fetchCalled, false, `expected no network call for slug ${JSON.stringify(slug)}`);
  }
});

test('encodes the slug it sends to the API', async () => {
  let calledPath;
  const cloudflareFetchFn = async (path) => {
    calledPath = path;
    return {};
  };

  // validateSlug's legal charset (lowercase letters/digits/dashes) is
  // already URL-safe, so no legal slug's encoded form differs from its raw
  // form — the resulting path can't prove encodeURIComponent ran. Spying on
  // the global is what actually proves the defence-in-depth call happens.
  const originalEncodeURIComponent = globalThis.encodeURIComponent;
  let encodedWith;
  globalThis.encodeURIComponent = (value) => {
    encodedWith = value;
    return originalEncodeURIComponent(value);
  };
  try {
    await deleteProject({ ...CONTEXT, slug: 'a-b', cloudflareFetchFn });
  } finally {
    globalThis.encodeURIComponent = originalEncodeURIComponent;
  }

  assert.equal(encodedWith, 'a-b');
  assert.equal(calledPath, '/accounts/acc/pages/projects/a-b');
});
