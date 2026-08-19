import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listCommand } from './list.js';

/**
 * `listCommand` has no injectable `resolveAuthFn`/`listProjectsFn` (unlike
 * `checkAuth`), so the only seam available without editing `list.js` is the
 * transport itself: stub `globalThis.fetch` to return a Cloudflare-shaped
 * envelope. `resolveAuth()` still resolves real credentials from `.env`/
 * `process.env` as it would in production, but since `fetch` never reaches
 * the network, no request is actually sent and no credential is exposed —
 * only used in-memory to build a request object that's immediately
 * discarded by the stub.
 */
function cloudflareEnvelope(result) {
  return { success: true, errors: [], messages: [], result };
}

async function withMockedFetch(result, run) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = [];
  globalThis.fetch = async () =>
    new Response(JSON.stringify(cloudflareEnvelope(result)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const returned = await run();
    return { returned, logs };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
}

test('human output prints a table of projects and returns nothing extra', async () => {
  const projects = [{ name: 'my-app', subdomain: 'my-app.pages.dev', production_branch: 'main' }];
  const { returned, logs } = await withMockedFetch(projects, () => listCommand([]));

  assert.deepEqual(returned, {});
  assert.equal(logs.length, 1);
  // Columns are padded/aligned, so split on runs of 2+ spaces rather than
  // asserting an exact fixed-width string — this proves the real values and
  // column order, without pinning the test to incidental padding widths.
  const lines = logs[0].split('\n');
  assert.deepEqual(
    lines.map((line) => line.split(/\s{2,}/)),
    [
      ['NAME', 'SUBDOMAIN', 'PRODUCTION BRANCH'],
      ['my-app', 'my-app.pages.dev', 'main'],
    ],
  );
});

test('human output prints the empty-account message when there are no projects', async () => {
  const { returned, logs } = await withMockedFetch([], () => listCommand([]));

  assert.deepEqual(returned, {});
  assert.deepEqual(logs, ['No projects found.']);
});

test('--json returns {projects, count} and prints nothing itself', async () => {
  const projects = [{ name: 'my-app', subdomain: 'my-app.pages.dev', production_branch: 'main' }];
  const { returned, logs } = await withMockedFetch(projects, () => listCommand(['--json']));

  assert.deepEqual(returned, {
    projects: [{ name: 'my-app', subdomain: 'my-app.pages.dev', domains: [], productionBranch: 'main' }],
    count: 1,
  });
  assert.deepEqual(logs, []);
});

test('--json returns an empty projects array and zero count for an empty account', async () => {
  const { returned, logs } = await withMockedFetch([], () => listCommand(['--json']));

  assert.deepEqual(returned, { projects: [], count: 0 });
  assert.deepEqual(logs, []);
});
