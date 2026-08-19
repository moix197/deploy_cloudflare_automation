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

test('encodes an accountId containing reserved characters into the request path', async () => {
  // validateSlug's legal charset (lowercase letters/digits/dashes) is
  // already URL-safe, so no legal slug's encoded form ever differs from its
  // raw form — the slug can't prove encodeURIComponent ran. `accountId` is
  // not slug-validated, so a `/`-bearing value gives a real, observable
  // assertion: if encoding were dropped, the requested path would contain a
  // raw `/` and split into the wrong number of segments.
  let calledPath;
  const cloudflareFetchFn = async (path) => {
    calledPath = path;
    return {};
  };
  await deleteProject({ ...CONTEXT, accountId: 'a/b', cloudflareFetchFn });
  assert.equal(calledPath, '/accounts/a%2Fb/pages/projects/my-app');
});
