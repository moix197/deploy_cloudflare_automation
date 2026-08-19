import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isAbsolute } from 'node:path';

import { runWrangler } from './runWrangler.js';
import { RateLimitError, WranglerExecutionError } from '../errors.js';

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function emitOutcome(child, { exitCode, stdout = '', stderr = '' }) {
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode);
  });
}

test('resolves with stdout on a clean exit', async () => {
  const spawnFn = (binPath, args, opts) => {
    const child = createFakeChild();
    emitOutcome(child, { exitCode: 0, stdout: 'Deployment complete' });
    return child;
  };
  const result = await runWrangler(['pages', 'deploy', 'C:\\abs\\dir'], { apiToken: 't', accountId: 'a', spawnFn });
  assert.match(result.stdout, /Deployment complete/);
});

test('spawns with cwd set to this package directory, not the deployed site directory', async () => {
  let capturedCwd;
  const siteDir = 'C:\\some\\site\\dir';
  const spawnFn = (binPath, args, opts) => {
    capturedCwd = opts.cwd;
    const child = createFakeChild();
    emitOutcome(child, { exitCode: 0 });
    return child;
  };
  await runWrangler(['pages', 'deploy', siteDir], { apiToken: 't', accountId: 'a', spawnFn });
  assert.notEqual(capturedCwd, siteDir);
  assert.ok(isAbsolute(capturedCwd));
});

test('forwards the asset directory argument through as an absolute path, verbatim', async () => {
  let capturedArgs;
  const siteDir = 'C:\\some\\site\\dir';
  const spawnFn = (binPath, args, opts) => {
    capturedArgs = args;
    const child = createFakeChild();
    emitOutcome(child, { exitCode: 0 });
    return child;
  };
  await runWrangler(['pages', 'deploy', siteDir, '--project-name', 'x'], { apiToken: 't', accountId: 'a', spawnFn });
  assert.ok(isAbsolute(siteDir));
  assert.equal(capturedArgs[2], siteDir);
});

test('passes the resolved credentials through as env vars', async () => {
  let capturedEnv;
  const spawnFn = (binPath, args, opts) => {
    capturedEnv = opts.env;
    const child = createFakeChild();
    emitOutcome(child, { exitCode: 0 });
    return child;
  };
  await runWrangler(['pages', 'deploy', 'C:\\abs\\dir'], { apiToken: 'tok-123', accountId: 'acc-456', spawnFn });
  assert.equal(capturedEnv.CLOUDFLARE_API_TOKEN, 'tok-123');
  assert.equal(capturedEnv.CLOUDFLARE_ACCOUNT_ID, 'acc-456');
  assert.equal(capturedEnv.WRANGLER_SEND_METRICS, 'false');
});

test('maps a non-zero exit with 429-shaped stderr to RateLimitError', async () => {
  const spawnFn = () => {
    const child = createFakeChild();
    emitOutcome(child, { exitCode: 1, stderr: 'Error: 429 Too Many Requests' });
    return child;
  };
  await assert.rejects(
    () => runWrangler(['pages', 'deploy', 'C:\\abs\\dir'], { apiToken: 't', accountId: 'a', spawnFn }),
    RateLimitError,
  );
});

test('maps any other non-zero exit to WranglerExecutionError carrying the real stderr verbatim', async () => {
  const spawnFn = () => {
    const child = createFakeChild();
    emitOutcome(child, { exitCode: 1, stderr: 'Error: too many files (20001), limit is 20000' });
    return child;
  };
  await assert.rejects(
    () => runWrangler(['pages', 'deploy', 'C:\\abs\\dir'], { apiToken: 't', accountId: 'a', spawnFn }),
    (error) => error instanceof WranglerExecutionError && /too many files/.test(error.stderr),
  );
});
