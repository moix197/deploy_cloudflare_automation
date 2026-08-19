import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listProjects } from './listProjects.js';

const CONTEXT = { apiToken: 'token', accountId: 'acc' };

test('maps raw Cloudflare project objects to the package shape', async () => {
  const cloudflareFetchFn = async (path) => {
    assert.equal(path, '/accounts/acc/pages/projects?page=1&per_page=10');
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

function makeProject(index) {
  return { name: `app-${index}`, subdomain: `app-${index}.pages.dev`, production_branch: 'main' };
}

test('a single, non-full page does not trigger a second request', async () => {
  let callCount = 0;
  const cloudflareFetchFn = async (path) => {
    callCount += 1;
    assert.equal(path, '/accounts/acc/pages/projects?page=1&per_page=10');
    return [makeProject(1), makeProject(2)];
  };
  const result = await listProjects({ ...CONTEXT, cloudflareFetchFn });
  assert.equal(callCount, 1);
  assert.equal(result.length, 2);
});

function pageNumberFromPath(path) {
  return Number(new URLSearchParams(path.split('?')[1]).get('page'));
}

test('follows pagination across a full page and combines all results', async () => {
  const pageOne = Array.from({ length: 10 }, (_, i) => makeProject(i));
  const pageTwo = [makeProject(10), makeProject(11)];
  const paths = [];
  const cloudflareFetchFn = async (path) => {
    paths.push(path);
    return pageNumberFromPath(path) === 1 ? pageOne : pageTwo;
  };
  const result = await listProjects({ ...CONTEXT, cloudflareFetchFn });
  assert.deepEqual(paths, [
    '/accounts/acc/pages/projects?page=1&per_page=10',
    '/accounts/acc/pages/projects?page=2&per_page=10',
  ]);
  assert.equal(result.length, 12);
  assert.equal(result[0].name, 'app-0');
  assert.equal(result[11].name, 'app-11');
});

test('stops once a page comes back with fewer than per_page results', async () => {
  const pageOne = Array.from({ length: 10 }, (_, i) => makeProject(i));
  const pageTwo = Array.from({ length: 10 }, (_, i) => makeProject(10 + i));
  const pageThree = [makeProject(20)];
  let callCount = 0;
  const cloudflareFetchFn = async (path) => {
    callCount += 1;
    const page = pageNumberFromPath(path);
    if (page === 1) return pageOne;
    if (page === 2) return pageTwo;
    return pageThree;
  };
  const result = await listProjects({ ...CONTEXT, cloudflareFetchFn });
  assert.equal(callCount, 3);
  assert.equal(result.length, 21);
});
