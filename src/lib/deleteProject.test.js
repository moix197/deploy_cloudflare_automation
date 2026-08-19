import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deleteProject } from './deleteProject.js';
import { CloudflareHttpError } from './cloudflareApi.js';
import { ProjectNotFoundError } from '../errors.js';

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
