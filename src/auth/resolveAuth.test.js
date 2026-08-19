import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAuth } from './resolveAuth.js';
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
