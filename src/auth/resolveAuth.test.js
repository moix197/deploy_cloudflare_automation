import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAuth, resolveShardedAuth } from './resolveAuth.js';
import { MissingCredentialError } from '../errors.js';

test('explicit args take precedence over .env and process.env', () => {
  const result = resolveAuth(
    { apiToken: 'arg-token', accountId: 'arg-account' },
    {
      env: { CLOUDFLARE_API_TOKEN: 'env-token', CLOUDFLARE_ACCOUNT_ID: 'env-account' },
      envFile: { CLOUDFLARE_API_TOKEN: 'file-token', CLOUDFLARE_ACCOUNT_ID: 'file-account' },
    },
  );
  assert.deepEqual(result, { apiToken: 'arg-token', accountId: 'arg-account' });
});

test('.env values take precedence over process.env', () => {
  const result = resolveAuth(
    {},
    {
      env: { CLOUDFLARE_API_TOKEN: 'env-token', CLOUDFLARE_ACCOUNT_ID: 'env-account' },
      envFile: { CLOUDFLARE_API_TOKEN: 'file-token', CLOUDFLARE_ACCOUNT_ID: 'file-account' },
    },
  );
  assert.deepEqual(result, { apiToken: 'file-token', accountId: 'file-account' });
});

test('falls back to process.env when no args or .env values are set', () => {
  const result = resolveAuth(
    {},
    { env: { CLOUDFLARE_API_TOKEN: 'env-token', CLOUDFLARE_ACCOUNT_ID: 'env-account' }, envFile: {} },
  );
  assert.deepEqual(result, { apiToken: 'env-token', accountId: 'env-account' });
});

test('an empty .env value falls through to process.env instead of shadowing it', () => {
  const result = resolveAuth(
    {},
    {
      env: { CLOUDFLARE_API_TOKEN: 'env-token', CLOUDFLARE_ACCOUNT_ID: 'env-account' },
      envFile: { CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '   ' },
    },
  );
  assert.deepEqual(result, { apiToken: 'env-token', accountId: 'env-account' });
});

test('throws MissingCredentialError naming CLOUDFLARE_API_TOKEN when it is missing', () => {
  assert.throws(
    () => resolveAuth({}, { env: {}, envFile: {} }),
    (error) => error instanceof MissingCredentialError && error.varName === 'CLOUDFLARE_API_TOKEN',
  );
});

test('throws MissingCredentialError naming CLOUDFLARE_ACCOUNT_ID when it is missing', () => {
  assert.throws(
    () => resolveAuth({ apiToken: 'token' }, { env: {}, envFile: {} }),
    (error) => error instanceof MissingCredentialError && error.varName === 'CLOUDFLARE_ACCOUNT_ID',
  );
});

test('resolveShardedAuth: DEMOS_* process.env beats the package .env and CLOUDFLARE_* env', () => {
  const result = resolveShardedAuth(
    {},
    {
      env: { DEMOS_CLOUDFLARE_API_TOKEN: 'demos-token', DEMOS_CLOUDFLARE_ACCOUNT_ID: 'demos-account', CLOUDFLARE_API_TOKEN: 'env-token' },
      envFile: { CLOUDFLARE_API_TOKEN: 'file-token', CLOUDFLARE_ACCOUNT_ID: 'file-account' },
    },
  );
  assert.deepEqual(result, { apiToken: 'demos-token', accountId: 'demos-account' });
});

test('resolveShardedAuth: explicit args beat DEMOS_*; blank DEMOS_* falls back to resolveAuth', () => {
  const env = { DEMOS_CLOUDFLARE_API_TOKEN: 'demos-token', DEMOS_CLOUDFLARE_ACCOUNT_ID: '  ' };
  const envFile = { CLOUDFLARE_API_TOKEN: 'file-token', CLOUDFLARE_ACCOUNT_ID: 'file-account' };
  assert.deepEqual(resolveShardedAuth({ apiToken: 'arg-token' }, { env, envFile }), { apiToken: 'arg-token', accountId: 'file-account' });
  assert.deepEqual(resolveShardedAuth({}, { env: {}, envFile }), { apiToken: 'file-token', accountId: 'file-account' });
});
