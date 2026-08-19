import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listProjects } from './listProjects.js';

const CONTEXT = { apiToken: 'token', accountId: 'acc' };

test('maps raw Cloudflare project objects to the package shape', async () => {
  const cloudflareFetchFn = async (path) => {
    assert.equal(path, '/accounts/acc/pages/projects');
    return [
      {
        name: 'my-app',
        subdomain: 'my-app.pages.dev',
        domains: ['my-app.pages.dev'],
        production_branch: 'main',
        extra_field_to_ignore: true,
      },
    ];
  };
  const result = await listProjects({ ...CONTEXT, cloudflareFetchFn });
  assert.deepEqual(result, [
    { name: 'my-app', subdomain: 'my-app.pages.dev', domains: ['my-app.pages.dev'], productionBranch: 'main' },
  ]);
});

test('returns an empty array for an account with no projects', async () => {
  const cloudflareFetchFn = async () => [];
  const result = await listProjects({ ...CONTEXT, cloudflareFetchFn });
  assert.deepEqual(result, []);
});

test('defaults domains to an empty array when Cloudflare omits it', async () => {
  const cloudflareFetchFn = async () => [{ name: 'my-app', subdomain: 'my-app.pages.dev', production_branch: 'main' }];
  const result = await listProjects({ ...CONTEXT, cloudflareFetchFn });
  assert.deepEqual(result[0].domains, []);
});
