import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RateLimitError, WranglerExecutionError } from '../errors.js';

const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
// Spawn the wrangler JS entrypoint directly via `process.execPath`, not the
// `.bin/wrangler(.cmd)` shim. A shim requires `shell: true` on Windows to
// execute, and Node does not quote argv when `shell` is true — any path
// containing a space (e.g. the site directory) gets silently mangled, and an
// untrusted path becomes a shell-injection vector. Invoking the JS file with
// `process.execPath` needs no shell at all, so argv reaches wrangler intact
// on every platform.
const WRANGLER_BIN = join(PACKAGE_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

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
 * TTY and cannot fall back to an interactive prompt. No `shell`, so argv is
 * passed to the OS exactly as built — no re-quoting, no injection risk from
 * a directory name containing spaces or shell metacharacters. `spawnFn` and
 * `binPath` are injectable for tests; real callers never pass either. Used
 * only for the actual asset upload — never for reading back the deployed
 * URL.
 */
export function runWrangler(args, { apiToken, accountId, spawnFn = spawn, binPath = WRANGLER_BIN } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(process.execPath, [binPath, ...args], {
      cwd: PACKAGE_ROOT,
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
