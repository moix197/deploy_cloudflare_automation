import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { runWrangler } from './runWrangler.js';
import { MissingWranglerEntrypointError, RateLimitError, WranglerExecutionError } from '../errors.js';

function withFakeBinPath(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cfpd-wrangler-bin-'));
  const binPath = join(dir, 'wrangler.js');
  writeFileSync(binPath, '');
  try {
    return fn(binPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

test('spawns process.execPath with the resolved wrangler.js path plus the given args, no shell', async () =>
  withFakeBinPath(async (binPath) => {
    let capturedCommand;
    let capturedArgs;
    let capturedOpts;
    const siteDir = 'C:\\some\\site\\dir';
    const spawnFn = (command, args, opts) => {
      capturedCommand = command;
      capturedArgs = args;
      capturedOpts = opts;
      const child = createFakeChild();
      emitOutcome(child, { exitCode: 0 });
      return child;
    };
    await runWrangler(['pages', 'deploy', siteDir, '--project-name', 'x'], {
      apiToken: 't',
      accountId: 'a',
      spawnFn,
      binPath,
    });
    assert.equal(capturedCommand, process.execPath);
    assert.deepEqual(capturedArgs, [binPath, 'pages', 'deploy', siteDir, '--project-name', 'x']);
    assert.equal(capturedOpts.shell, undefined);
  }));

test('throws MissingWranglerEntrypointError naming the resolved path when the binPath does not exist on disk', async () => {
  const binPath = join(tmpdir(), 'cfpd-does-not-exist', 'wrangler.js');
  const spawnFn = () => {
    throw new Error('spawnFn should never be called when the entrypoint is missing');
  };

  await assert.rejects(
    () => runWrangler(['pages', 'deploy', 'C:\\abs\\dir'], { apiToken: 't', accountId: 'a', spawnFn, binPath }),
    (error) => error instanceof MissingWranglerEntrypointError && error.binPath === binPath,
  );
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
