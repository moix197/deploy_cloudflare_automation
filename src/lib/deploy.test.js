import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isAbsolute } from 'node:path';

import { deploy } from './deploy.js';
import { MissingSubdomainError, RateLimitError } from '../errors.js';

function makeSiteDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cfpd-deploy-'));
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  return dir;
}

function withSiteDir(fn) {
  const dir = makeSiteDir();
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('fires onStart, onProgress, onDone in order and returns the expected shape', () =>
  withSiteDir(async (dir) => {
    const calls = [];
    const result = await deploy({
      dir,
      slug: 'my-app',
      onStart: () => calls.push('start'),
      onProgress: (phase) => calls.push(`progress:${phase}`),
      onDone: () => calls.push('done'),
      onError: () => calls.push('error'),
      resolveAuthFn: () => ({ apiToken: 't', accountId: 'a' }),
      ensureProjectFn: async () => ({ name: 'my-app' }),
      runWranglerFn: async () => ({ stdout: 'ok' }),
      // Deliberately NOT derivable from `slug` (`<slug>.pages.dev` would be
      // 'my-app.pages.dev') — proves the URL comes from the REST readback,
      // not from constructing it out of the slug.
      readProjectSubdomainFn: async () => 'renamed-xyz.pages.dev',
    });

    assert.deepEqual(calls, ['start', 'progress:uploading', 'done']);
    assert.deepEqual(result, {
      url: 'https://renamed-xyz.pages.dev',
      slug: 'my-app',
      projectName: 'my-app',
      status: 'deployed',
    });
  }));

test('passes an absolute site path and the expected wrangler args through to runWrangler', () =>
  withSiteDir(async (dir) => {
    let capturedArgs;

    await deploy({
      dir,
      slug: 'my-app',
      resolveAuthFn: () => ({ apiToken: 't', accountId: 'a' }),
      ensureProjectFn: async () => ({}),
      runWranglerFn: async (args) => {
        capturedArgs = args;
        return { stdout: '' };
      },
      readProjectSubdomainFn: async () => 'renamed-xyz.pages.dev',
    });

    assert.equal(capturedArgs[0], 'pages');
    assert.equal(capturedArgs[1], 'deploy');
    assert.ok(isAbsolute(capturedArgs[2]));
    assert.deepEqual(capturedArgs.slice(3), [
      '--project-name',
      'my-app',
      '--branch',
      'main',
      '--commit-dirty=true',
    ]);
  }));

test('throws MissingSubdomainError when the REST readback returns no subdomain', () =>
  withSiteDir(async (dir) => {
    let onErrorCalledWith;

    await assert.rejects(
      () =>
        deploy({
          dir,
          slug: 'my-app',
          onError: (error) => {
            onErrorCalledWith = error;
          },
          resolveAuthFn: () => ({ apiToken: 't', accountId: 'a' }),
          ensureProjectFn: async () => ({}),
          runWranglerFn: async () => ({ stdout: '' }),
          readProjectSubdomainFn: async () => undefined,
        }),
      MissingSubdomainError,
    );

    assert.ok(onErrorCalledWith instanceof MissingSubdomainError);
  }));

test('resolves credentials exactly once and passes the same pair to ensureProject and runWrangler', () =>
  withSiteDir(async (dir) => {
    let resolveCount = 0;
    const seenByEnsureProject = [];
    const seenByRunWrangler = [];

    await deploy({
      dir,
      slug: 'my-app',
      resolveAuthFn: () => {
        resolveCount += 1;
        return { apiToken: 'tok', accountId: 'acc' };
      },
      ensureProjectFn: async ({ apiToken, accountId }) => {
        seenByEnsureProject.push({ apiToken, accountId });
        return {};
      },
      runWranglerFn: async (args, { apiToken, accountId }) => {
        seenByRunWrangler.push({ apiToken, accountId });
        return { stdout: '' };
      },
      readProjectSubdomainFn: async () => 'my-app.pages.dev',
    });

    assert.equal(resolveCount, 1);
    assert.deepEqual(seenByEnsureProject[0], { apiToken: 'tok', accountId: 'acc' });
    assert.deepEqual(seenByRunWrangler[0], { apiToken: 'tok', accountId: 'acc' });
  }));

test('propagates a RateLimitError from runWrangler to the caller and to onError, without retrying', () =>
  withSiteDir(async (dir) => {
    let runWranglerCallCount = 0;
    let onErrorCalledWith;

    await assert.rejects(
      () =>
        deploy({
          dir,
          slug: 'my-app',
          onError: (error) => {
            onErrorCalledWith = error;
          },
          resolveAuthFn: () => ({ apiToken: 't', accountId: 'a' }),
          ensureProjectFn: async () => ({}),
          runWranglerFn: async () => {
            runWranglerCallCount += 1;
            throw new RateLimitError('429');
          },
          readProjectSubdomainFn: async () => 'my-app.pages.dev',
        }),
      RateLimitError,
    );

    assert.equal(runWranglerCallCount, 1);
    assert.ok(onErrorCalledWith instanceof RateLimitError);
  }));

test('fires onError and rejects, without calling onStart, on an invalid slug', () =>
  withSiteDir(async (dir) => {
    const calls = [];
    await assert.rejects(() =>
      deploy({
        dir,
        slug: 'Invalid_Slug!',
        onStart: () => calls.push('start'),
        onDone: () => calls.push('done'),
        onError: () => calls.push('error'),
        resolveAuthFn: () => ({ apiToken: 't', accountId: 'a' }),
      }),
    );
    assert.deepEqual(calls, ['error']);
  }));
