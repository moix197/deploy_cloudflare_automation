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

test('encodes an accountId containing reserved characters into the request path', async () => {
  let calledPath;
  const cloudflareFetchFn = async (path) => {
    calledPath = path;
    return [];
  };
  await listProjects({ apiToken: 'token', accountId: 'a/b', cloudflareFetchFn });
  assert.equal(calledPath, '/accounts/a%2Fb/pages/projects?page=1&per_page=10');
});

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

test('a result set that is an exact multiple of the page size still terminates', async () => {
  // 20 projects across two full pages of 10; the third (empty) page proves
  // the loop keeps going past two full pages but still stops once a
  // short page comes back — not because it hit MAX_PAGES.
  const pageOne = Array.from({ length: 10 }, (_, i) => makeProject(i));
  const pageTwo = Array.from({ length: 10 }, (_, i) => makeProject(10 + i));
  let callCount = 0;
  const cloudflareFetchFn = async (path) => {
    callCount += 1;
    const page = pageNumberFromPath(path);
    if (page === 1) return pageOne;
    if (page === 2) return pageTwo;
    return [];
  };
  const result = await listProjects({ ...CONTEXT, cloudflareFetchFn });
  assert.equal(callCount, 3);
  assert.equal(result.length, 20);
});

test('self-resolves credentials via resolveAuthFn when apiToken/accountId are not supplied', async () => {
  let calledWithOverrides;
  const resolveAuthFn = (overrides) => {
    calledWithOverrides = overrides;
    return { apiToken: 'resolved-token', accountId: 'resolved-acc' };
  };
  let calledPath;
  const cloudflareFetchFn = async (path) => {
    calledPath = path;
    return [];
  };
  await listProjects({ cloudflareFetchFn, resolveAuthFn });
  assert.deepEqual(calledWithOverrides, { apiToken: undefined, accountId: undefined });
  assert.equal(calledPath, '/accounts/resolved-acc/pages/projects?page=1&per_page=10');
});

test('passes explicitly-supplied apiToken/accountId through to resolveAuthFn as overrides (explicit wins)', async () => {
  let calledWithOverrides;
  const resolveAuthFn = (overrides) => {
    calledWithOverrides = overrides;
    return overrides;
  };
  let calledPath;
  const cloudflareFetchFn = async (path) => {
    calledPath = path;
    return [];
  };
  await listProjects({ apiToken: 'explicit-token', accountId: 'explicit-acc', cloudflareFetchFn, resolveAuthFn });
  assert.deepEqual(calledWithOverrides, { apiToken: 'explicit-token', accountId: 'explicit-acc' });
  assert.equal(calledPath, '/accounts/explicit-acc/pages/projects?page=1&per_page=10');
});

test('a null/undefined page does not throw and is treated as the end of results', async () => {
  const cloudflareFetchFn = async () => undefined;
  const result = await listProjects({ ...CONTEXT, cloudflareFetchFn });
  assert.deepEqual(result, []);
});

test('an API that ignores `page` and always returns a full page terminates at MAX_PAGES instead of hanging', async () => {
  // Bounded mock: `full page forever` is exactly the pathological input the
  // MAX_PAGES cap exists to survive. Capping the mock's own responses (not
  // just asserting the call count afterwards) means a regression that
  // removes the cap fails this test fast via the assertion below rather than
  // hanging the whole suite.
  let callCount = 0;
  const cloudflareFetchFn = async () => {
    callCount += 1;
    if (callCount > 25) {
      throw new Error('runaway pagination: fetch called more than 25 times');
    }
    return Array.from({ length: 10 }, (_, i) => makeProject(i));
  };
  const result = await listProjects({ ...CONTEXT, cloudflareFetchFn });
  assert.equal(callCount, 20, 'expected the loop to stop at MAX_PAGES');
  assert.equal(result.length, 200);
});
