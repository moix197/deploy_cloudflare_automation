import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RateLimitError, WranglerExecutionError } from '../errors.js';

const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const WRANGLER_BIN = join(
  PACKAGE_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
);

function isRateLimitedFailure(stderr) {
  return /\b429\b/.test(stderr) || /rate.?limit/i.test(stderr);
}

function collectChunks(stream, chunks) {
  stream.on('data', (chunk) => chunks.push(chunk));
}

function buildEnv({ apiToken, accountId }) {
  return {
    ...process.env,
    CLOUDFLARE_API_TOKEN: apiToken,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    WRANGLER_SEND_METRICS: 'false',
  };
}

/**
 * Spawns the local wrangler binary (never `npx`) with `cwd` fixed to this
 * package's own directory — guaranteed config-file-free — so a stray
 * wrangler.toml in an ancestor of the caller's site directory can never
 * hijack config discovery. No `stdio: 'inherit'`, so wrangler never sees a
 * TTY and cannot fall back to an interactive prompt. `spawnFn` is injectable
 * for tests; real callers never pass it. Used only for the actual asset
 * upload — never for reading back the deployed URL.
 */
export function runWrangler(args, { apiToken, accountId, spawnFn = spawn, binPath = WRANGLER_BIN } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(binPath, args, {
      cwd: PACKAGE_ROOT,
      shell: process.platform === 'win32',
      env: buildEnv({ apiToken, accountId }),
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    collectChunks(child.stdout, stdoutChunks);
    collectChunks(child.stderr, stderrChunks);

    child.on('error', reject);
    child.on('close', (exitCode) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (exitCode === 0) {
        resolve({ stdout, stderr });
        return;
      }
      if (isRateLimitedFailure(stderr)) {
        reject(new RateLimitError(stderr));
        return;
      }
      reject(new WranglerExecutionError(stderr, exitCode));
    });
  });
}
